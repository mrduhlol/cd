package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

const clerkIssuer = "https://electric-arachnid-4684.clerk.accounts.dev"
const clerkClientID = "A5eL6DW58r6rKyit"

type accountTokens struct {
	Access    string `json:"access_token"`
	Refresh   string `json:"refresh_token"`
	ExpiresIn int64  `json:"expires_in"`
	ExpiresAt int64  `json:"expires_at"`
	Error     string `json:"error"`
}

var accountHTTP = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func accountTokenPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "cdx", "account.json"), nil
}
func saveAccount(tokens accountTokens) error {
	path, err := accountTokenPath()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tokens.ExpiresAt = time.Now().Unix() + tokens.ExpiresIn
	return resumeAtomicJSON(path, tokens)
}
func oauthPost(ctx context.Context, endpoint string, values url.Values, output any) error {
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := accountHTTP.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 {
		return errors.New("Clerk is temporarily unavailable")
	}
	return json.NewDecoder(io.LimitReader(response.Body, 32768)).Decode(output)
}
func accountAccess(ctx context.Context) (string, error) {
	path, err := accountTokenPath()
	if err != nil {
		return "", err
	}
	var tokens accountTokens
	if err = resumeReadJSON(path, &tokens); err != nil {
		return "", fmt.Errorf("run cdx login first: %w", err)
	}
	if tokens.ExpiresAt > time.Now().Unix()+60 {
		return tokens.Access, nil
	}
	var next accountTokens
	err = oauthPost(ctx, clerkIssuer+"/oauth/token", url.Values{"client_id": {clerkClientID}, "grant_type": {"refresh_token"}, "refresh_token": {tokens.Refresh}}, &next)
	if err != nil {
		return "", err
	}
	if next.Access == "" {
		return "", errors.New("login expired; run cdx login again")
	}
	if next.Refresh == "" {
		next.Refresh = tokens.Refresh
	}
	if err = saveAccount(next); err != nil {
		return "", err
	}
	return next.Access, nil
}
func accountRequest(ctx context.Context, method, path string, body any, output any) error {
	token, err := accountAccess(ctx)
	if err != nil {
		return err
	}
	relay, _, err := endpointBase()
	if err != nil {
		return err
	}
	u, err := url.Parse(relay)
	if err != nil {
		return err
	}
	if u.Scheme == "wss" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" {
		return errors.New("account operations require HTTPS")
	}
	if u.Host == "cd.yash0.in" {
		u.Host = "cd-test.yash0.in"
	}
	u.Path = "/api/account/v1" + path
	u.RawQuery = ""
	u.Fragment = ""
	data := ""
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		data = string(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := accountHTTP.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("account request failed (%d)", response.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
	}
	return nil
}
func runLogin(args []string) int {
	if len(args) != 0 {
		return deviceFailure(errors.New("usage: cdx login"), false)
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	var metadata struct {
		Device string `json:"device_authorization_endpoint"`
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", clerkIssuer+"/.well-known/openid-configuration", nil)
	res, err := accountHTTP.Do(req)
	if err != nil {
		return deviceFailure(err, false)
	}
	err = json.NewDecoder(io.LimitReader(res.Body, 32768)).Decode(&metadata)
	res.Body.Close()
	if err != nil {
		return deviceFailure(err, false)
	}
	if metadata.Device != clerkIssuer+"/oauth/device_authorization" {
		return deviceFailure(errors.New("invalid Clerk device endpoint"), false)
	}
	var device struct {
		Code     string `json:"device_code"`
		UserCode string `json:"user_code"`
		URI      string `json:"verification_uri"`
		Complete string `json:"verification_uri_complete"`
		Expires  int    `json:"expires_in"`
		Interval int    `json:"interval"`
	}
	err = oauthPost(ctx, metadata.Device, url.Values{"client_id": {clerkClientID}, "scope": {"openid profile email offline_access"}}, &device)
	if err != nil {
		return deviceFailure(err, false)
	}
	if device.Code == "" || device.Expires <= 0 || device.Interval <= 0 {
		return deviceFailure(errors.New("Clerk did not issue a login request"), false)
	}
	fmt.Fprintf(os.Stderr, "Sign in at %s\nConfirm code: %s\n%s\n", device.URI, device.UserCode, device.Complete)
	ctx, cancel := context.WithTimeout(ctx, time.Duration(device.Expires)*time.Second)
	defer cancel()
	interval := time.Duration(device.Interval) * time.Second
	for {
		select {
		case <-ctx.Done():
			return deviceFailure(errors.New("login cancelled or expired"), false)
		case <-time.After(interval):
		}
		var tokens accountTokens
		err = oauthPost(ctx, clerkIssuer+"/oauth/token", url.Values{"client_id": {clerkClientID}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {device.Code}}, &tokens)
		if err != nil {
			interval += time.Second
			continue
		}
		switch tokens.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "":
		default:
			return deviceFailure(fmt.Errorf("Clerk login failed: %s", tokens.Error), false)
		}
		if tokens.Access == "" || tokens.Refresh == "" {
			return deviceFailure(errors.New("Clerk did not issue renewable credentials"), false)
		}
		if err = saveAccount(tokens); err != nil {
			return deviceFailure(err, false)
		}
		fmt.Fprintln(os.Stdout, "Signed in. Enable account receiving in CD on your phone.")
		return 0
	}
}

func accountIdentity(ctx context.Context) (string, error) {
	token, err := accountAccess(ctx)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", clerkIssuer+"/oauth/userinfo", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := accountHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", errors.New("Clerk login is no longer valid; run cdx login")
	}
	var user struct {
		Subject string `json:"sub"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 32768)).Decode(&user); err != nil {
		return "", err
	}
	if !strings.HasPrefix(user.Subject, "user_") || len(user.Subject) > 133 {
		return "", errors.New("invalid Clerk identity")
	}
	return user.Subject, nil
}

func runAccount(args []string) int {
	if len(args) == 0 || (args[0] != "devices" && args[0] != "revoke") {
		return deviceFailure(errors.New("usage: cdx account devices | cdx account revoke <name>"), false)
	}
	if (args[0] == "devices" && len(args) != 1) || (args[0] == "revoke" && len(args) != 2) {
		return deviceFailure(errors.New("usage: cdx account devices | cdx account revoke <name>"), false)
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	var directory struct {
		Phones []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"phones"`
	}
	if err := accountRequest(ctx, "GET", "", nil, &directory); err != nil {
		return deviceFailure(err, false)
	}
	if args[0] == "devices" {
		for _, phone := range directory.Phones {
			fmt.Fprintln(os.Stdout, phone.Name)
		}
		return 0
	}
	for _, phone := range directory.Phones {
		if phone.Name == args[1] {
			if err := accountRequest(ctx, "DELETE", "/phone", map[string]string{"id": phone.ID}, nil); err != nil {
				return deviceFailure(err, false)
			}
			fmt.Fprintln(os.Stdout, "Revoked", phone.Name)
			return 0
		}
	}
	return deviceFailure(errors.New("account device not found"), false)
}
