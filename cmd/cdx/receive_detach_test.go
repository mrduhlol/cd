package main

import (
	"reflect"
	"testing"
)

func TestBackgroundReceivePreservesOptions(t *testing.T) {
	request, err := parseReceiveArgs([]string{"--detach", "--resume", "--force", "--progress", "--out", "file with spaces", "--", "https://example.com/s/test#v2.private"})
	if err != nil {
		t.Fatal(err)
	}
	if !request.detach {
		t.Fatal("background receiving was not selected")
	}
	want := []string{"receive", "--json", "--resume", "--force", "--progress", "--out", "file with spaces", "--", "https://example.com/s/test#v2.private"}
	if got := backgroundReceiveArgs(request); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	child, err := parseReceiveArgs(want[1:])
	if err != nil {
		t.Fatal(err)
	}
	if child.detach {
		t.Fatal("child must not recursively detach")
	}
}
