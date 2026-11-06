package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Short numeric share codes ("48291") are the one plane every sender and
// receiver speaks: `cdx send` prints one, `cdx receive` and the browser
// Receive box accept it, and the relay directory resolves it to the transfer.
// Codes are random, expire after 15 minutes, and admit a single receiver.
// Unlike full links, the directory holds the transfer key, so code transfers
// rely on TLS + the live relay instead of end-to-end encryption.
var shortCodePattern = regexp.MustCompile(`^\d{4,5}$`)

func isShortCode(value string) bool {
	return shortCodePattern.MatchString(strings.TrimSpace(value))
}

// shortCodeFromLink returns the code in a link like https://cd.yash0.in/#48291,
// or "" when value is not such a link.
func shortCodeFromLink(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || strings.Trim(parsed.Path, "/") != "" || !isShortCode(parsed.Fragment) {
		return ""
	}
	return parsed.Fragment
}

type codeClaimRequest struct {
	TransferID string `json:"transferId"`
	Key        string `json:"key"`
}

type codeClaimResponse struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

type codeLookupResponse struct {
	TransferID string `json:"transferId"`
	Key        string `json:"key"`
}

func codesEndpoint(publicBase string) string {
	return strings.TrimRight(publicBase, "/") + "/api/codes"
}

func codeHTTPClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second}
}

// claimShareCode reserves a short code for an admitted sender room.
func claimShareCode(ctx context.Context, publicBase, transferID, key string) (string, error) {
	payload, err := json.Marshal(codeClaimRequest{TransferID: transferID, Key: key})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, codesEndpoint(publicBase), bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := codeHTTPClient().Do(request)
	if err != nil {
		return "", fmt.Errorf("reserve a share code: %w", friendlyRelayError(err))
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if err != nil {
		return "", NewFailure(failureProtocol, "reserve a share code: the relay sent an unreadable response", retryNever)
	}
	switch {
	case response.StatusCode == http.StatusTooManyRequests:
		return "", NewFailure(failureBusy, "share codes are busy right now: wait a moment and try again", retrySameRequest)
	case response.StatusCode == http.StatusServiceUnavailable:
		return "", NewFailure(failureBusy, "share codes are busy right now: wait a moment and try again", retrySameRequest)
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return "", failuref(failureProtocol, retryNever, "reserve a share code: the relay rejected the request (HTTP %d)", response.StatusCode)
	}
	var claimed codeClaimResponse
	if err := json.Unmarshal(body, &claimed); err != nil || !isShortCode(claimed.Code) {
		return "", NewFailure(failureProtocol, "reserve a share code: the relay sent an invalid code", retryNever)
	}
	return strings.TrimSpace(claimed.Code), nil
}

// lookupShareCode resolves a typed code to its transfer invitation.
func lookupShareCode(ctx context.Context, publicBase, code string) (invitation, error) {
	cleaned := strings.TrimSpace(code)
	if !isShortCode(cleaned) {
		return invitation{}, NewFailure(failureInvalidCode, "this CD code is invalid: type the 4-5 digit code from the sender", retryNever)
	}
	var response *http.Response
	err := retrySetup(ctx, func() error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, codesEndpoint(publicBase)+"/"+cleaned, nil)
		if err != nil {
			return err
		}
		response, err = codeHTTPClient().Do(request)
		if err != nil {
			return fmt.Errorf("look up the share code: %w", err)
		}
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			response.Body.Close()
			return failuref(failureBusy, retrySameRequest, "share code lookup temporarily unavailable (HTTP %d): wait a moment and try again", response.StatusCode)
		}
		return nil
	})
	if err != nil {
		return invitation{}, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return invitation{}, NewFailure(failureNotFound, "bad code, or the sender is no longer available", retryNever)
	case http.StatusTooManyRequests:
		return invitation{}, NewFailure(failureBusy, "too many attempts: wait a moment and try again", retrySameRequest)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return invitation{}, failuref(failureProtocol, retryNever, "look up the share code: the relay rejected the request (HTTP %d)", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if err != nil {
		return invitation{}, NewFailure(failureProtocol, "look up the share code: the relay sent an unreadable response", retryNever)
	}
	var found codeLookupResponse
	if err := json.Unmarshal(body, &found); err != nil {
		return invitation{}, NewFailure(failureProtocol, "look up the share code: the relay sent an invalid response", retryNever)
	}
	value, err := parseInvitationParts(found.TransferID, found.Key)
	if err != nil {
		return invitation{}, NewFailure(failureProtocol, "look up the share code: the relay sent invalid transfer details", retryNever, err)
	}
	return value, nil
}
