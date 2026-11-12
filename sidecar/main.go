// Command sidecar links one WhatsApp account with whatsmeow and exposes it to
// the Node app over a Unix socket (protocol v1, see docs/plan-tres-horas).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"runtime/debug"
	"syscall"
)

func version() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "go.mau.fi/whatsmeow" {
				return "whatsmeow-" + dep.Version
			}
		}
	}
	return "whatsmeow-unknown"
}

func main() {
	socket := flag.String("socket", "", "Unix socket path (directory is created 0700)")
	db := flag.String("db", "", "SQLite path for the device store")
	number := flag.String("number", "", "expected phone number, digits only, with country code")
	flag.Parse()
	if *socket == "" || *db == "" || !regexp.MustCompile(`^[1-9]\d{6,14}$`).MatchString(*number) {
		fmt.Fprintln(os.Stderr, "usage: sidecar -socket PATH -db PATH -number 5215550000001")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	backend, err := NewWhatsmeowBackend(ctx, *db, *number)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open the session store")
		os.Exit(1)
	}
	_ = os.Chmod(*db, 0o600)
	server := NewServer(backend, version())
	listener, err := Listen(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot listen on the socket")
		os.Exit(1)
	}
	go func() {
		if err := backend.Run(ctx, server.Emit); err != nil {
			fmt.Fprintln(os.Stderr, "whatsapp backend stopped")
			stop()
		}
	}()
	_ = server.Serve(ctx, listener)
}
