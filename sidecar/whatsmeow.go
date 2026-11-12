package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

// MaxAudioBytes caps the voice notes forwarded to Node (frames are 1 MiB).
const MaxAudioBytes = 600 * 1024

// WhatsmeowBackend adapts a whatsmeow client to Backend.
type WhatsmeowBackend struct {
	cli      *whatsmeow.Client
	expectPN string

	mu    sync.Mutex
	phase string
	emit  func(Frame)
	// passkey is only held between a request and its confirmation.
	passkeyPending bool
}

// NewWhatsmeowBackend opens (creating if needed) the device store at dbPath.
// expectPN is the phone number, digits only, the session must belong to.
func NewWhatsmeowBackend(ctx context.Context, dbPath, expectPN string) (*WhatsmeowBackend, error) {
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	container := sqlstore.NewWithDB(db, "sqlite", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		return nil, err
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, err
	}
	b := &WhatsmeowBackend{cli: whatsmeow.NewClient(device, waLog.Noop), expectPN: expectPN, phase: PhaseUnpaired}
	if device.ID != nil {
		b.phase = PhaseDisconnected
	}
	return b, nil
}

func (b *WhatsmeowBackend) identity() []string {
	if b.cli.Store.ID == nil {
		return nil
	}
	ids := []string{b.cli.Store.ID.ToNonAD().String()}
	if !b.cli.Store.LID.IsEmpty() {
		ids = append(ids, b.cli.Store.LID.ToNonAD().String())
	}
	return ids
}

// canonPN folds Mexico's two WhatsApp spellings (52 + 10 digits and 521 + 10
// digits) into one, so the configured number matches whichever the server uses.
func canonPN(user string) string {
	if len(user) == 13 && strings.HasPrefix(user, "521") {
		return "52" + user[3:]
	}
	return user
}

// identityMatches is true only when the linked phone number is the expected one.
func (b *WhatsmeowBackend) identityMatches() bool {
	return b.cli.Store.ID != nil && canonPN(b.cli.Store.ID.ToNonAD().User) == canonPN(b.expectPN)
}

func (b *WhatsmeowBackend) Status() Frame {
	b.mu.Lock()
	defer b.mu.Unlock()
	f := frame(TStatus)
	f.Phase = b.phase
	if b.identityMatches() && b.cli.IsConnected() {
		f.Identity = b.identity()
	}
	return f
}

func (b *WhatsmeowBackend) setPhase(p string) {
	b.mu.Lock()
	b.phase = p
	emit := b.emit
	b.mu.Unlock()
	if emit != nil {
		emit(b.Status())
	}
}

func (b *WhatsmeowBackend) Run(ctx context.Context, emit func(Frame)) error {
	b.mu.Lock()
	b.emit = emit
	b.mu.Unlock()
	b.cli.AddEventHandler(func(evt any) { b.handle(emit, evt) })
	if b.cli.Store.ID == nil {
		b.setPhase(PhasePairing)
		// Each QR channel ends after about two minutes. Open a fresh one until the
		// account is linked, so the QR can always be regenerated without a restart.
		first := true
		for b.cli.Store.ID == nil && ctx.Err() == nil {
			if !first {
				select {
				case <-ctx.Done():
				case <-time.After(2 * time.Second):
				}
				if ctx.Err() != nil {
					break
				}
			}
			first = false
			qr, err := b.cli.GetQRChannel(ctx)
			if err != nil {
				return err
			}
			if err := b.cli.ConnectContext(ctx); err != nil {
				return err
			}
			done := make(chan struct{})
			go b.pairingFrames(emit, qr, done)
			select {
			case <-done:
			case <-ctx.Done():
			}
		}
	} else if err := b.cli.ConnectContext(ctx); err != nil {
		return err
	}
	<-ctx.Done()
	b.cli.Disconnect()
	return nil
}

// pairingFrames forwards QR and passkey items. It returns when the channel closes.
func (b *WhatsmeowBackend) pairingFrames(emit func(Frame), qr <-chan whatsmeow.QRChannelItem, done chan<- struct{}) {
	for item := range qr {
		switch item.Event {
		case whatsmeow.QRChannelEventCode:
			f := frame(TPairQR)
			f.Code = item.Code
			emit(f)
		case whatsmeow.QRChannelEventPasskeyRequest:
			if item.PasskeyRequest != nil {
				payload, _ := json.Marshal(item.PasskeyRequest.PublicKey)
				f := frame(TPasskeyReq)
				f.Payload = payload
				b.mu.Lock()
				b.passkeyPending = true
				b.mu.Unlock()
				emit(f)
			}
		case whatsmeow.QRChannelEventPasskeyResponse:
			if item.PasskeyConfirmation != nil {
				f := frame(TPasskeyCode)
				f.Code = item.PasskeyConfirmation.Code
				emit(f)
			}
		case whatsmeow.QRChannelEventError:
			f := frame(TPasskeyError)
			f.Detail = "pairing failed"
			emit(f)
		}
	}
	close(done)
}

func (b *WhatsmeowBackend) handle(emit func(Frame), evt any) {
	if os.Getenv("SIDECAR_DEBUG_EVENTS") == "1" {
		// Event type names only: never payloads, codes or identifiers.
		fmt.Fprintf(os.Stderr, "event %T\n", evt)
	}
	switch e := evt.(type) {
	case *events.Connected:
		b.setPhase(PhaseConnected)
	case *events.Disconnected:
		b.setPhase(PhaseDisconnected)
	case *events.LoggedOut:
		b.setPhase(PhaseUnpaired)
	case *events.PairSuccess:
		b.setPhase(PhaseConnected)
	case *events.Message:
		if e.Info.IsGroup || e.Info.Chat.Server == types.BroadcastServer || e.Info.Chat.Server == types.NewsletterServer {
			return
		}
		f := frame(TMessage)
		f.Chat = e.Info.Chat.ToNonAD().String()
		alt := e.Info.SenderAlt
		if e.Info.IsFromMe {
			alt = e.Info.RecipientAlt
		}
		if !alt.IsEmpty() {
			f.ChatAlt = alt.ToNonAD().String()
		}
		f.ID, f.FromMe, f.At = e.Info.ID, e.Info.IsFromMe, e.Info.Timestamp.UnixMilli()
		m := e.Message
		switch {
		case m.GetConversation() != "":
			f.Text = m.GetConversation()
		case m.GetExtendedTextMessage() != nil:
			f.Text = m.GetExtendedTextMessage().GetText()
			f.QuotedID = m.GetExtendedTextMessage().GetContextInfo().GetStanzaID()
		case m.GetImageMessage() != nil:
			f.Text = m.GetImageMessage().GetCaption()
			f.HasImage = true
		case m.GetAudioMessage() != nil:
			f.HasAudio = true
			a := m.GetAudioMessage()
			f.AudioMime = a.GetMimetype()
			if a.GetFileLength() > 0 && a.GetFileLength() <= MaxAudioBytes {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				data, err := b.cli.Download(ctx, a)
				cancel()
				if err == nil && len(data) <= MaxAudioBytes {
					f.AudioB64 = base64.StdEncoding.EncodeToString(data)
				}
			}
		}
		if f.Text == "" && !f.HasImage && !f.HasAudio {
			return
		}
		emit(f)
	}
}

func (b *WhatsmeowBackend) Send(ctx context.Context, req SendRequest) (string, string) {
	if !b.identityMatches() {
		return OutcomeBeforeTransmit, "session identity does not match the configured number"
	}
	to, err := types.ParseJID(req.To)
	if err != nil || to.Server != types.DefaultUserServer && to.Server != types.HiddenUserServer || canonPN(to.ToNonAD().User) == canonPN(b.expectPN) {
		return OutcomeBeforeTransmit, "recipient is not an individual chat of someone else"
	}
	var msg *waE2E.Message
	if len(req.Image) > 0 {
		up, err := b.cli.Upload(ctx, req.Image, whatsmeow.MediaImage)
		if err != nil {
			return OutcomeBeforeTransmit, "image upload failed"
		}
		msg = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption: proto.String(req.Text), Mimetype: proto.String("image/png"),
			URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength,
		}}
	} else {
		msg = &waE2E.Message{Conversation: proto.String(req.Text)}
	}
	_, err = b.cli.SendMessage(ctx, to.ToNonAD(), msg, whatsmeow.SendRequestExtra{ID: types.MessageID(req.ID), Timeout: 60 * time.Second})
	switch {
	case err == nil:
		return OutcomeAcked, ""
	case errors.Is(err, whatsmeow.ErrNotConnected), errors.Is(err, whatsmeow.ErrNotLoggedIn):
		return OutcomeBeforeTransmit, "not connected"
	default:
		return OutcomeUncertain, "send outcome unknown"
	}
}

func (b *WhatsmeowBackend) PasskeyResponse(payload json.RawMessage) error {
	b.mu.Lock()
	pending := b.passkeyPending
	b.mu.Unlock()
	if !pending {
		return errors.New("no passkey request in progress")
	}
	var resp types.WebAuthnResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		return err
	}
	return b.cli.SendPasskeyResponse(context.Background(), &resp)
}

func (b *WhatsmeowBackend) PasskeyConfirm() error {
	b.mu.Lock()
	pending := b.passkeyPending
	b.passkeyPending = false
	b.mu.Unlock()
	if !pending {
		return errors.New("no passkey confirmation in progress")
	}
	return b.cli.SendPasskeyConfirmation(context.Background())
}

func (b *WhatsmeowBackend) PasskeyCancel() {
	b.mu.Lock()
	b.passkeyPending = false
	b.mu.Unlock()
	b.cli.Disconnect()
}

var errPairPhone = errors.New("pairing code unavailable")

// PairPhone requests a linking code for the expected number only. The QR
// channel keeps running; whichever the user completes first links the device.
func (b *WhatsmeowBackend) PairPhone(ctx context.Context, phone string) (string, error) {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, phone)
	if canonPN(digits) != canonPN(b.expectPN) {
		return "", errors.New("number does not match the expected number")
	}
	if b.cli.Store.ID != nil {
		return "", errors.New("already linked")
	}
	if !b.cli.IsConnected() {
		return "", errors.New("not connected to WhatsApp yet")
	}
	code, err := b.cli.PairPhone(ctx, digits, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		return "", fmt.Errorf("%w: %v", errPairPhone, err)
	}
	return code, nil
}
