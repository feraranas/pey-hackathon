package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeBackend struct {
	mu       sync.Mutex
	sends    []SendRequest
	outcome  string
	block    chan struct{}
	passkeys int
	status   Frame
}

func (f *fakeBackend) Run(ctx context.Context, emit func(Frame)) error { <-ctx.Done(); return nil }
func (f *fakeBackend) Status() Frame                                   { return f.status }
func (f *fakeBackend) PasskeyResponse(json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.passkeys++
	return nil
}
func (f *fakeBackend) PasskeyConfirm() error { return nil }
func (f *fakeBackend) PasskeyCancel()        {}
func (f *fakeBackend) Send(ctx context.Context, r SendRequest) (string, string) {
	f.mu.Lock()
	f.sends = append(f.sends, r)
	f.mu.Unlock()
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return OutcomeUncertain, "timeout"
		}
	}
	return f.outcome, ""
}

func start(t *testing.T, b *fakeBackend) (*Server, string, func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "run", "wa.sock")
	l, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(b, "test")
	ctx, cancel := context.WithCancel(context.Background())
	go s.Serve(ctx, l)
	return s, path, cancel
}

type client struct {
	c net.Conn
	r *bufio.Reader
}

func dial(t *testing.T, path string) *client {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	return &client{c: c, r: bufio.NewReader(c)}
}
func (c *client) send(t *testing.T, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if _, err := c.c.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}
func (c *client) next(t *testing.T) Frame {
	t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f Frame
	if err := json.Unmarshal(line, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestSocketIsPrivateAndHelloCarriesVersion(t *testing.T) {
	_, path, stop := start(t, &fakeBackend{status: Frame{Phase: PhaseConnected, Identity: []string{"5215550000001@s.whatsapp.net"}}})
	defer stop()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v err %v", info.Mode(), err)
	}
	dirInfo, _ := os.Stat(filepath.Dir(path))
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", dirInfo.Mode())
	}
	c := dial(t, path)
	hello := c.next(t)
	if hello.T != THello || hello.Protocol != ProtocolVersion || hello.Version != "test" {
		t.Fatalf("hello %+v", hello)
	}
	status := c.next(t)
	if status.T != TStatus || status.Phase != PhaseConnected || len(status.Identity) != 1 {
		t.Fatalf("status %+v", status)
	}
}

func TestSendReportsEachOutcomeAndNeverRetries(t *testing.T) {
	for _, outcome := range []string{OutcomeAcked, OutcomeBeforeTransmit, OutcomeUncertain} {
		b := &fakeBackend{outcome: outcome}
		_, path, stop := start(t, b)
		c := dial(t, path)
		c.next(t)
		c.next(t)
		c.send(t, Frame{V: 1, T: TSend, Ref: "r1", ID: "MSG1", To: "5215550000002@s.whatsapp.net", Text: "hola"})
		res := c.next(t)
		if res.T != TSendResult || res.Ref != "r1" || res.ID != "MSG1" || res.Outcome != outcome {
			t.Fatalf("%s: %+v", outcome, res)
		}
		if len(b.sends) != 1 {
			t.Fatalf("sent %d times", len(b.sends))
		}
		stop()
	}
}

func TestInvalidSendNeverReachesTheBackend(t *testing.T) {
	b := &fakeBackend{outcome: OutcomeAcked}
	_, path, stop := start(t, b)
	defer stop()
	c := dial(t, path)
	c.next(t)
	c.next(t)
	c.send(t, Frame{V: 1, T: TSend, Ref: "r1", To: "x@s.whatsapp.net", Text: "no id"})
	res := c.next(t)
	if res.Outcome != OutcomeBeforeTransmit || len(b.sends) != 0 {
		t.Fatalf("%+v sends=%d", res, len(b.sends))
	}
}

func TestSendTimeoutIsUncertain(t *testing.T) {
	b := &fakeBackend{outcome: OutcomeAcked, block: make(chan struct{})}
	s, path, stop := start(t, b)
	s.sendTimeout = 50 * time.Millisecond
	defer stop()
	c := dial(t, path)
	c.next(t)
	c.next(t)
	c.send(t, Frame{V: 1, T: TSend, Ref: "r1", ID: "M", To: "5215550000002@s.whatsapp.net", Text: "x"})
	if res := c.next(t); res.Outcome != OutcomeUncertain {
		t.Fatalf("%+v", res)
	}
}

func TestIncompatibleVersionAndUnknownFramesCloseTheConnection(t *testing.T) {
	_, path, stop := start(t, &fakeBackend{})
	defer stop()
	for _, bad := range []any{Frame{V: 2, T: TSend}, Frame{V: 1, T: "exec"}, "not json"} {
		c := dial(t, path)
		c.next(t)
		c.next(t)
		c.send(t, bad)
		if f := c.next(t); f.T != TProtocolError {
			t.Fatalf("%+v", f)
		}
		_ = c.c.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := c.r.ReadBytes('\n'); err == nil {
			t.Fatal("connection stayed open")
		}
	}
}

func TestOversizedFrameClosesTheConnection(t *testing.T) {
	_, path, stop := start(t, &fakeBackend{})
	defer stop()
	c := dial(t, path)
	c.next(t)
	c.next(t)
	_, _ = c.c.Write([]byte(strings.Repeat("a", MaxFrameBytes+10) + "\n"))
	_ = c.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.r.ReadBytes('\n'); err == nil {
		t.Fatal("expected the connection to close")
	}
}

func TestSecondClientIsRefused(t *testing.T) {
	_, path, stop := start(t, &fakeBackend{})
	defer stop()
	first := dial(t, path)
	first.next(t)
	first.next(t)
	time.Sleep(50 * time.Millisecond)
	second := dial(t, path)
	if f := second.next(t); f.T != TProtocolError {
		t.Fatalf("%+v", f)
	}
}

func TestMessagesQueueWhileOfflineAndOverflowFailsClosed(t *testing.T) {
	s, path, stop := start(t, &fakeBackend{})
	defer stop()
	s.queueLimit = 2
	for i := 0; i < 3; i++ {
		s.Emit(Frame{T: TMessage, ID: string(rune('a' + i)), Chat: "c"})
	}
	c := dial(t, path)
	c.next(t)
	c.next(t)
	if f := c.next(t); f.T != TOverflow {
		t.Fatalf("expected overflow first, got %+v", f)
	}
	s.Emit(Frame{T: TMessage, ID: "live", Chat: "c"})
	if f := c.next(t); f.ID != "live" {
		t.Fatalf("%+v", f)
	}
}

func TestPasskeyFramesReachTheBackend(t *testing.T) {
	b := &fakeBackend{}
	_, path, stop := start(t, b)
	defer stop()
	c := dial(t, path)
	c.next(t)
	c.next(t)
	c.send(t, map[string]any{"v": 1, "t": TPasskeyResponse, "payload": map[string]string{"id": "x"}})
	time.Sleep(100 * time.Millisecond)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.passkeys != 1 {
		t.Fatalf("passkey responses %d", b.passkeys)
	}
}

func TestPairingFramesAreReplayedToALateClientUntilConnected(t *testing.T) {
	s, path, stop := start(t, &fakeBackend{status: Frame{Phase: PhasePairing}})
	defer stop()
	s.Emit(Frame{T: TPairQR, Code: "qr-1"})
	s.Emit(Frame{T: TPairQR, Code: "qr-2"})
	c := dial(t, path)
	c.next(t)
	c.next(t)
	if f := c.next(t); f.T != TPairQR || f.Code != "qr-2" {
		t.Fatalf("%+v", f)
	}
	c.c.Close()
	time.Sleep(50 * time.Millisecond)
	s.Emit(Frame{T: TStatus, Phase: PhaseConnected})
	c2 := dial(t, path)
	c2.next(t)
	c2.next(t)
	s.Emit(Frame{T: TMessage, ID: "m", Chat: "c"})
	if f := c2.next(t); f.T != TMessage {
		t.Fatalf("stale pairing frame replayed: %+v", f)
	}
}

func TestCanonPNFoldsMexicoSpellings(t *testing.T) {
	cases := map[string]string{
		"5217715697632":  "527715697632",
		"527715697632":   "527715697632",
		"5215550000001":  "525550000001",
		"14155550100":    "14155550100",
		"52155500000011": "52155500000011",
	}
	for in, want := range cases {
		if got := canonPN(in); got != want {
			t.Errorf("canonPN(%s)=%s want %s", in, got, want)
		}
	}
}
