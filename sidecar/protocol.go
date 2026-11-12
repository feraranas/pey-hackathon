package main

import "encoding/json"

// ProtocolVersion is bumped on any incompatible change. The Node adapter
// refuses a sidecar that reports a different version.
const ProtocolVersion = 1

// MaxFrameBytes bounds one NDJSON frame in both directions.
const MaxFrameBytes = 1 << 20

// Frame types, sidecar to Node.
const (
	THello         = "hello"
	TStatus        = "status"
	TMessage       = "message"
	TSendResult    = "send_result"
	TPairQR        = "pair_qr"
	TPasskeyReq    = "passkey_request"
	TPasskeyCode   = "passkey_code"
	TPasskeyError  = "passkey_error"
	TOverflow      = "overflow"
	TProtocolError = "protocol_error"
)

// Frame types, Node to sidecar.
const (
	TSend            = "send"
	TPasskeyResponse = "passkey_response"
	TPasskeyConfirm  = "passkey_confirm"
	TPasskeyCancel   = "passkey_cancel"
)

// Send outcomes. "acked" is a WhatsApp server acknowledgement, never a
// delivery receipt and never a payment.
const (
	OutcomeAcked          = "acked"
	OutcomeBeforeTransmit = "failed_before_transmit"
	OutcomeUncertain      = "uncertain"
)

// Phases reported in status frames.
const (
	PhaseUnpaired     = "unpaired"
	PhasePairing      = "pairing"
	PhaseConnected    = "connected"
	PhaseDisconnected = "disconnected"
)

// Frame is the single wire shape. Unused fields are omitted.
type Frame struct {
	V    int    `json:"v"`
	T    string `json:"t"`
	Ref  string `json:"ref,omitempty"`
	ID   string `json:"id,omitempty"`
	Chat string `json:"chat,omitempty"`
	// ChatAlt is the other address of the same 1:1 chat (phone number or LID).
	ChatAlt  string `json:"chatAlt,omitempty"`
	To       string `json:"to,omitempty"`
	FromMe   bool   `json:"fromMe,omitempty"`
	At       int64  `json:"at,omitempty"`
	Text     string `json:"text,omitempty"`
	QuotedID string `json:"quotedId,omitempty"`
	HasImage bool   `json:"hasImage,omitempty"`
	// ImageB64 carries an image to send, for QR charges.
	ImageB64 string          `json:"imageB64,omitempty"`
	Outcome  string          `json:"outcome,omitempty"`
	Detail   string          `json:"detail,omitempty"`
	Version  string          `json:"version,omitempty"`
	Protocol int             `json:"protocol,omitempty"`
	Phase    string          `json:"phase,omitempty"`
	Identity []string        `json:"identity,omitempty"`
	Code     string          `json:"code,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

func frame(t string) Frame { return Frame{V: ProtocolVersion, T: t} }
