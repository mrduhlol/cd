package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

func backgroundReceiveArgs(request receiveRequest) []string {
	args := []string{"receive", "--json"}
	if request.resume {
		args = append(args, "--resume")
	}
	if request.force {
		args = append(args, "--force")
	}
	if request.progress {
		args = append(args, "--progress")
	}
	if request.out != "" {
		args = append(args, "--out", request.out)
	}
	return append(args, "--", request.code)
}

func runDetachedReceive(request receiveRequest) int {
	return runBackgroundTransfer(backgroundReceiveArgs(request), request.jsonOutput, "receive")
}

func runBackgroundTransfer(args []string, jsonOutput bool, kind string) int {
	fail := func(err error) int { reportFailure(os.Stdout, os.Stderr, err, jsonOutput); return 1 }
	executable, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	dir, err := stateDir()
	if err != nil {
		return fail(err)
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return fail(err)
	}
	log, err := os.CreateTemp(dir, kind+"-*.log")
	if err != nil {
		return fail(err)
	}
	defer log.Close()
	command := exec.Command(executable, args...)
	command.SysProcAttr = detachAttributes()
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		os.Remove(log.Name())
		return fail(err)
	}
	pid := command.Process.Pid
	command.Process.Release()
	if jsonOutput {
		err = json.NewEncoder(os.Stdout).Encode(struct {
			PID int    `json:"pid"`
			Log string `json:"log"`
		}{pid, log.Name()})
	} else {
		_, err = fmt.Fprintf(os.Stdout, "Transfer running in background (PID %d). Results and errors: %s\n", pid, log.Name())
	}
	if err != nil {
		return fail(err)
	}
	return 0
}
