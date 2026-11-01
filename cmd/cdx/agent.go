package main

import (
	"bufio"
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// agentSkill is generated from skills/cd-file-sharing/source.md.
// Run node scripts/generate-sharing-skill.mjs after editing the source.
//
//go:embed agentskill/SKILL.md
var agentSkill string

const (
	agentBlockBegin = "<!-- cdx:begin -->"
	agentBlockEnd   = "<!-- cdx:end -->"
	agentSkillName  = "cd-file-sharing"
)

// agentBlock is the note added to agents that read one global instructions
// file instead of skill folders.
const agentBlock = agentBlockBegin + `
## Sharing files

When the user asks to send to their phone, run ` + "`cdx send --to phone --json <path>`" + ` and read the returned private log to confirm delivery. Otherwise, when the user asks to send, share, or hand off a file, run ` + "`cdx send <path>`" + `
and reply with the link https://cd.yash0.in/#<code>, using the code it prints;
opening the link starts the download (or they run ` + "`cdx receive <code>`" + `). Prefer it over upload sites: no account, nothing stored.
For a QR in chat, run ` + "`cdx send --json --qr <fresh-png-path> <path>`" + ` and embed
the returned qrPath as a Markdown image with an absolute path (works in T3 Code).
Use ` + "`cdx send --link <path>`" + ` for sensitive files. Details: ` + "`cdx help send`" + `.
` + agentBlockEnd + "\n"

// agentTarget is one place an agent reads instructions from.
type agentTarget struct {
	name string
	// home is the directory whose presence means the agent is installed.
	home string
	// path is the file cdx writes: a SKILL.md, or an instructions file that
	// gets agentBlock.
	path  string
	skill bool
}

func agentTargets(home string) []agentTarget {
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	return []agentTarget{
		{name: "Claude Code", home: filepath.Join(home, ".claude"), path: filepath.Join(home, ".claude", "skills", agentSkillName, "SKILL.md"), skill: true},
		{name: "Codex", home: codexHome, path: filepath.Join(codexHome, "AGENTS.md")},
		{name: "Gemini CLI", home: filepath.Join(home, ".gemini"), path: filepath.Join(home, ".gemini", "GEMINI.md")},
		{name: "opencode", home: filepath.Join(configHome, "opencode"), path: filepath.Join(configHome, "opencode", "AGENTS.md")},
		{name: "Other agents (~/.agents/skills)", home: filepath.Join(home, ".agents"), path: filepath.Join(home, ".agents", "skills", agentSkillName, "SKILL.md"), skill: true},
	}
}

func (target agentTarget) detected() bool {
	info, err := os.Stat(target.home)
	return err == nil && info.IsDir()
}

func (target agentTarget) installed() bool {
	data, err := os.ReadFile(target.path)
	if err != nil {
		return false
	}
	return target.skill || strings.Contains(string(data), agentBlockBegin)
}

func (target agentTarget) install() error {
	if err := os.MkdirAll(filepath.Dir(target.path), 0o755); err != nil {
		return err
	}
	if target.skill {
		return os.WriteFile(target.path, []byte(agentSkill), 0o644)
	}
	existing, err := os.ReadFile(target.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	text := removeAgentBlock(string(existing))
	if text != "" && !strings.HasSuffix(text, "\n\n") {
		text = strings.TrimRight(text, "\n") + "\n\n"
	}
	return os.WriteFile(target.path, []byte(text+agentBlock), 0o644)
}

func (target agentTarget) remove() error {
	if target.skill {
		err := os.RemoveAll(filepath.Dir(target.path))
		return err
	}
	existing, err := os.ReadFile(target.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.WriteFile(target.path, []byte(removeAgentBlock(string(existing))), 0o644)
}

// removeAgentBlock drops the cdx block, so setup can rerun without duplicating it.
func removeAgentBlock(text string) string {
	start := strings.Index(text, agentBlockBegin)
	if start < 0 {
		return text
	}
	end := strings.Index(text[start:], agentBlockEnd)
	if end < 0 {
		return text
	}
	end += start + len(agentBlockEnd)
	if end < len(text) && text[end] == '\n' {
		end++
	}
	rest := strings.TrimRight(text[:start], "\n")
	if rest != "" {
		rest += "\n"
	}
	if tail := strings.TrimLeft(text[end:], "\n"); tail != "" {
		if rest != "" {
			rest += "\n"
		}
		rest += tail
	}
	return rest
}

func agentUsage(output io.Writer) {
	fmt.Fprintln(output, "usage: cdx agent setup [--yes] [--dry-run]")
	fmt.Fprintln(output, "   or: cdx agent remove")
	fmt.Fprintln(output, "   or: cdx agent status")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Teach the AI coding agents on this machine to share files with cdx, so")
	fmt.Fprintln(output, "\"send me this file\" gets you a code instead of an upload link.")
	fmt.Fprintln(output, "Claude Code and ~/.agents get the cd-file-sharing skill; Codex, Gemini CLI")
	fmt.Fprintln(output, "and opencode get a short note in their global instructions file, between")
	fmt.Fprintln(output, agentBlockBegin+" markers that 'cdx agent remove' takes out again.")
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "options for setup:")
	fmt.Fprintln(output, "  --yes       set up every detected agent without asking")
	fmt.Fprintln(output, "  --dry-run   show what would change and write nothing")
}

func runAgent(argv []string) int {
	return runAgentIn(argv, os.Getenv("HOME"), os.Stdin, os.Stdout)
}

func runAgentIn(argv []string, home string, input io.Reader, output io.Writer) int {
	if len(argv) == 0 || argv[0] == "-h" || argv[0] == "--help" || argv[0] == "help" {
		agentUsage(output)
		if len(argv) == 0 {
			return 2
		}
		return 0
	}
	if home == "" {
		if value, err := os.UserHomeDir(); err == nil {
			home = value
		}
	}
	if home == "" {
		fmt.Fprintln(os.Stderr, "cdx: cannot find your home directory")
		return 1
	}
	targets := agentTargets(home)
	command := argv[0]
	flags := flag.NewFlagSet("cdx agent "+command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	yes := flags.Bool("yes", false, "")
	flags.BoolVar(yes, "y", false, "")
	dryRun := flags.Bool("dry-run", false, "")
	if err := flags.Parse(argv[1:]); err != nil || flags.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "cdx: bad arguments for 'cdx agent %s'\n\n", command)
		agentUsage(os.Stderr)
		return 2
	}
	switch command {
	case "setup":
		return agentSetup(targets, home, *yes, *dryRun, input, output)
	case "remove":
		return agentRemove(targets, home, output)
	case "status":
		for _, target := range targets {
			fmt.Fprintf(output, "  %-32s %s\n", target.name, agentState(target, home))
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "cdx: unknown agent command %q\n\n", command)
		agentUsage(os.Stderr)
		return 2
	}
}

func agentState(target agentTarget, home string) string {
	switch {
	case target.installed():
		return "set up (" + tildePath(target.path, home) + ")"
	case target.detected():
		return "not set up"
	default:
		return "not installed"
	}
}

func agentSetup(targets []agentTarget, home string, yes, dryRun bool, input io.Reader, output io.Writer) int {
	fmt.Fprintln(output, "cdx can teach your AI coding agents to share files. Ask one to")
	fmt.Fprintln(output, "\"send me report.pdf\" and it runs `cdx send`, then replies with a link")
	fmt.Fprintln(output, "like https://cd.yash0.in/#48291 that starts the download when opened.")
	fmt.Fprintln(output, "")
	var found []agentTarget
	for _, target := range targets {
		if target.detected() {
			found = append(found, target)
		}
	}
	if len(found) == 0 {
		fmt.Fprintln(output, "No supported agents found (Claude Code, Codex, Gemini CLI, opencode).")
		fmt.Fprintln(output, "Install one, then run: cdx agent setup")
		fmt.Fprintln(output, "Or add the skill anywhere with: npx skills add YashasVM/cd")
		return 0
	}
	reader := bufio.NewReader(input)
	failed := false
	changed := 0
	for _, target := range found {
		where := tildePath(target.path, home)
		if !yes && !dryRun {
			fmt.Fprintf(output, "Set up %s? (%s) [Y/n] ", target.name, where)
			answer, err := reader.ReadString('\n')
			if err != nil && answer == "" {
				fmt.Fprintln(output, "")
				fmt.Fprintln(output, "No answer; nothing else changed. Run `cdx agent setup` any time.")
				break
			}
			answer = strings.ToLower(strings.TrimSpace(answer))
			if answer != "" && answer != "y" && answer != "yes" {
				fmt.Fprintf(output, "  skipped %s\n", target.name)
				continue
			}
		}
		if dryRun {
			fmt.Fprintf(output, "  would write %s for %s\n", where, target.name)
			continue
		}
		if err := target.install(); err != nil {
			fmt.Fprintf(os.Stderr, "cdx: could not set up %s: %v\n", target.name, err)
			failed = true
			continue
		}
		changed++
		fmt.Fprintf(output, "  ✓ %s: %s\n", target.name, where)
	}
	if changed > 0 {
		fmt.Fprintln(output, "")
		fmt.Fprintln(output, "Done. Try it: ask your agent to \"send me <some file> with cdx\".")
		fmt.Fprintln(output, "Undo with: cdx agent remove")
	}
	if failed {
		return 1
	}
	return 0
}

func agentRemove(targets []agentTarget, home string, output io.Writer) int {
	failed := false
	for _, target := range targets {
		if !target.installed() {
			continue
		}
		if err := target.remove(); err != nil {
			fmt.Fprintf(os.Stderr, "cdx: could not remove %s: %v\n", target.name, err)
			failed = true
			continue
		}
		fmt.Fprintf(output, "  removed cdx from %s (%s)\n", target.name, tildePath(target.path, home))
	}
	if failed {
		return 1
	}
	return 0
}

func tildePath(path, home string) string {
	if relative, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(relative, "..") {
		return filepath.Join("~", relative)
	}
	return path
}
