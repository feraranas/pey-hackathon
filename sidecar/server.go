package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SendRequest is a validated request to transmit one message.
type SendRequest struct {
	Ref, To, ID, Text string
	Image             []byte
}

// Backend is the WhatsApp side. Production uses whatsmeow; tests use a fake.
type Backend interface {
	// Run connects and emits frames until ctx ends or a fatal error occurs.
	Run(ctx context.Context, emit func(Frame)) error
	// Send never retries. It reports whether the message may have left.
	Send(ctx context.Context, req SendRequest) (outcome string, detail string)
	Status() Frame
	PasskeyResponse(payload json.RawMessage) error
	PasskeyConfirm() error
	PasskeyCancel()
	// PairPhone asks WhatsApp for an 8-character linking code for the expected number.
	PairPhone(ctx context.Context, phone string) (string, error)
}

// Server speaks NDJSON over a Unix socket with permissions 0600. One Node
// client at a time. It never listens on TCP.
type Server struct {
	backend     Backend
	version     string
	sendTimeout time.Duration
	queueLimit  int

	mu       sync.Mutex
	client   *conn
	queue    []Frame
	overflow bool
	// sticky holds the latest pairing frames so a client that connects after
	// they were emitted still sees them. Cleared once the session is connected.
	sticky map[string]Frame
}

type conn struct {
	c  net.Conn
	mu sync.Mutex
}

func (c *conn) write(f Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	_ = c.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = c.c.Write(append(b, '\n'))
	return err
}

func NewServer(b Backend, version string) *Server {
	return &Server{backend: b, version: version, sendTimeout: 90 * time.Second, queueLimit: 1000, sticky: map[string]Frame{}}
}

// Listen creates the socket in a 0700 directory with mode 0600.
func Listen(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	_ = os.Remove(path)
	old := umaskSet(0o177)
	l, err := net.Listen("unix", path)
	umaskSet(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = l.Close()
		return nil, err
	}
	return l, nil
}

// Emit receives backend frames. Messages go to the live client or a bounded
// queue; overflow is reported so the adapter fails closed.
func (s *Server) Emit(f Frame) {
	f.V = ProtocolVersion
	s.mu.Lock()
	defer s.mu.Unlock()
	switch f.T {
	case TPairQR, TPasskeyReq, TPasskeyCode:
		s.sticky[f.T] = f
	case TStatus:
		if f.Phase == PhaseConnected || f.Phase == PhaseUnpaired {
			s.sticky = map[string]Frame{}
		}
	}
	if s.client != nil {
		if err := s.client.write(f); err == nil {
			return
		}
	}
	if f.T != TMessage {
		return
	}
	if len(s.queue) >= s.queueLimit {
		s.overflow = true
		return
	}
	s.queue = append(s.queue, f)
}

func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	go func() { <-ctx.Done(); _ = l.Close() }()
	for {
		nc, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		s.mu.Lock()
		busy := s.client != nil
		s.mu.Unlock()
		if busy {
			c := &conn{c: nc}
			_ = c.write(Frame{V: ProtocolVersion, T: TProtocolError, Detail: "another client is connected"})
			_ = nc.Close()
			continue
		}
		go s.handle(ctx, nc)
	}
}

func (s *Server) handle(ctx context.Context, nc net.Conn) {
	c := &conn{c: nc}
	defer nc.Close()
	hello := frame(THello)
	hello.Version, hello.Protocol = s.version, ProtocolVersion
	if err := c.write(hello); err != nil {
		return
	}
	st := s.backend.Status()
	st.V, st.T = ProtocolVersion, TStatus
	if err := c.write(st); err != nil {
		return
	}
	s.mu.Lock()
	if s.overflow {
		s.overflow = false
		s.queue = nil
		_ = c.write(frame(TOverflow))
	}
	for _, f := range s.sticky {
		_ = c.write(f)
	}
	for _, f := range s.queue {
		_ = c.write(f)
	}
	s.queue = nil
	s.client = c
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.client == c {
			s.client = nil
		}
		s.mu.Unlock()
	}()

	r := bufio.NewReaderSize(nc, 64*1024)
	for {
		line, err := readLine(r)
		if err != nil {
			return
		}
		var f Frame
		if err := json.Unmarshal(line, &f); err != nil || f.V != ProtocolVersion {
			e := frame(TProtocolError)
			e.Detail = "invalid frame or incompatible protocol version"
			_ = c.write(e)
			return
		}
		switch f.T {
		case TSend:
			go s.send(ctx, c, f)
		case TPasskeyResponse:
			if err := s.backend.PasskeyResponse(f.Payload); err != nil {
				e := frame(TPasskeyError)
				e.Detail = "passkey response rejected"
				_ = c.write(e)
			}
		case TPasskeyConfirm:
			if err := s.backend.PasskeyConfirm(); err != nil {
				e := frame(TPasskeyError)
				e.Detail = "passkey confirmation failed"
				_ = c.write(e)
			}
		case TPasskeyCancel:
			s.backend.PasskeyCancel()
		case TPairPhone:
			go s.pairPhone(ctx, c, f)
		default:
			e := frame(TProtocolError)
			e.Detail = "unknown frame type"
			_ = c.write(e)
			return
		}
	}
}

var errFrameTooLarge = errors.New("frame too large")

func readLine(r *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		part, isPrefix, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
		if len(out) > MaxFrameBytes {
			return nil, errFrameTooLarge
		}
		if !isPrefix {
			return out, nil
		}
	}
}

func (s *Server) send(ctx context.Context, c *conn, f Frame) {
	result := frame(TSendResult)
	result.Ref, result.ID = f.Ref, f.ID
	if f.Ref == "" || f.ID == "" || f.To == "" || (f.Text == "" && f.ImageB64 == "") {
		result.Outcome, result.Detail = OutcomeBeforeTransmit, "invalid send request"
		_ = c.write(result)
		return
	}
	req := SendRequest{Ref: f.Ref, To: f.To, ID: f.ID, Text: f.Text}
	if f.ImageB64 != "" {
		img, err := base64.StdEncoding.DecodeString(f.ImageB64)
		if err != nil {
			result.Outcome, result.Detail = OutcomeBeforeTransmit, "invalid image"
			_ = c.write(result)
			return
		}
		req.Image = img
	}
	cctx, cancel := context.WithTimeout(ctx, s.sendTimeout)
	defer cancel()
	result.Outcome, result.Detail = s.backend.Send(cctx, req)
	if result.Outcome == "" {
		result.Outcome, result.Detail = OutcomeUncertain, fmt.Sprint("backend returned no outcome")
	}
	_ = c.write(result)
}

// pairPhone answers a pair_phone request. The code is a pairing secret: it goes
// only to the connected client and is never kept or logged here.
func (s *Server) pairPhone(ctx context.Context, c *conn, f Frame) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	code, err := s.backend.PairPhone(cctx, f.To)
	if err != nil {
		e := frame(TPairCodeError)
		e.Detail = err.Error()
		_ = c.write(e)
		return
	}
	out := frame(TPairCode)
	out.Code = code
	_ = c.write(out)
}
