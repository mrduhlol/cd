package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	qrcode "github.com/skip2/go-qrcode"
)

func receiveLink(value readyOutput) string {
	if value.Code != "" {
		return codeLink(value.Code)
	}
	return value.URL
}

func saveReadyQR(value *readyOutput, path string) error {
	if path == "" {
		return nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("QR output path: %w", err)
	}
	data, err := qrcode.Encode(receiveLink(*value), qrcode.Medium, -8)
	if err != nil {
		return fmt.Errorf("encode QR: %w", err)
	}
	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("save QR: %w", err)
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(absolute)
		if writeErr != nil {
			return fmt.Errorf("save QR: %w", writeErr)
		}
		return fmt.Errorf("save QR: %w", closeErr)
	}
	value.QRPath = absolute
	return nil
}

func writeTerminalQR(output io.Writer, value readyOutput) {
	qr, err := qrcode.New(receiveLink(value), qrcode.Medium)
	if err != nil {
		fmt.Fprintln(output, "  QR unavailable:", err)
		return
	}
	fmt.Fprintln(output, "  Scan to receive")
	// Explicit black/white colors keep the code scannable on light and dark themes.
	bitmap := qr.Bitmap()
	for y := 0; y < len(bitmap); y += 2 {
		fmt.Fprint(output, "  \x1b[30;107m")
		for x := range bitmap[y] {
			top := bitmap[y][x]
			bottom := y+1 < len(bitmap) && bitmap[y+1][x]
			cell := ' '
			switch {
			case top && bottom:
				cell = '█'
			case top:
				cell = '▀'
			case bottom:
				cell = '▄'
			}
			fmt.Fprint(output, string(cell))
		}
		fmt.Fprintln(output, "\x1b[0m")
	}
}
