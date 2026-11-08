package main

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"io"
	"os"
)

const transferCompression = "deflate-v1"

func compressionEnabled() bool { return os.Getenv("CD_COMPRESSION") != "0" }

type chunkCompressor struct {
	output bytes.Buffer
	writer *flate.Writer
}

// The caller reserves buffer[0], so incompressible data needs no extra copy.
func (c *chunkCompressor) encode(buffer []byte) ([]byte, error) {
	buffer[0] = 0
	raw := buffer[1:]
	// Sampling avoids spending compression CPU on photos, videos and archives.
	var seen [256]bool
	distinct := 0
	for _, b := range raw[:min(len(raw), 4096)] {
		if !seen[b] {
			seen[b] = true
			distinct++
		}
	}
	if len(raw) < 1024 || distinct > 224 {
		return buffer, nil
	}
	c.output.Reset()
	c.output.Write([]byte{1, 0, 0, 0, 0})
	binary.BigEndian.PutUint32(c.output.Bytes()[1:5], uint32(len(raw)))
	if c.writer == nil {
		c.writer, _ = flate.NewWriter(&c.output, flate.BestSpeed)
	} else {
		c.writer.Reset(&c.output)
	}
	if _, err := c.writer.Write(raw); err != nil {
		return nil, err
	}
	if err := c.writer.Close(); err != nil {
		return nil, err
	}
	if c.output.Len() >= len(buffer)*9/10 {
		return buffer, nil
	}
	return c.output.Bytes(), nil
}

type chunkDecompressor struct {
	output []byte
	reader io.ReadCloser
}

func (d *chunkDecompressor) close() {
	if d.reader != nil {
		_ = d.reader.Close()
	}
}

func (d *chunkDecompressor) decode(payload []byte, limit int) ([]byte, error) {
	invalid := func() ([]byte, error) {
		return nil, NewFailure(failureProtocol, "sender sent invalid compressed data", retryNever)
	}
	if len(payload) < 2 {
		return invalid()
	}
	if payload[0] == 0 {
		if len(payload)-1 > limit {
			return invalid()
		}
		return payload[1:], nil
	}
	if payload[0] != 1 || len(payload) < 6 {
		return invalid()
	}
	size := int(binary.BigEndian.Uint32(payload[1:5]))
	if size <= 0 || size > limit {
		return invalid()
	}
	source := bytes.NewReader(payload[5:])
	if d.reader == nil {
		d.reader = flate.NewReader(source)
	} else {
		if err := d.reader.(flate.Resetter).Reset(source, nil); err != nil {
			return invalid()
		}
	}
	if cap(d.output) < size {
		d.output = make([]byte, size)
	}
	output := d.output[:size]
	if _, err := io.ReadFull(d.reader, output); err != nil {
		return invalid()
	}
	var extra [1]byte
	n, err := d.reader.Read(extra[:])
	if n != 0 || err != io.EOF || source.Len() != 0 {
		return invalid()
	}
	return output, nil
}
