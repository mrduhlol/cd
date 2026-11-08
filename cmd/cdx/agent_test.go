package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSkillMatchesRepository(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "skills", agentSkillName, "source.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(source) != agentSkill {
		t.Fatal("generated sharing skill is stale; run node scripts/generate-sharing-skill.mjs")
	}
	repository, err := os.ReadFile(filepath.Join("..", "..", "skills", agentSkillName, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(repository) != agentSkill {
		t.Fatal("cmd/cdx/agentskill/SKILL.md differs from skills/cd-file-sharing/SKILL.md; run node scripts/generate-sharing-skill.mjs")
	}
}

func TestAgentSetupAsksPerAgentAndRemoveUndoes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	for _, dir := range []string{".claude", ".codex", ".gemini"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	codexFile := filepath.Join(home, ".codex", "AGENTS.md")
	if err := os.WriteFile(codexFile, []byte("# Mine\n\nKeep this.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	// Claude: yes, Codex: default, Gemini: no.
	if code := runAgentIn([]string{"setup"}, home, strings.NewReader("y\n\nn\n"), &output); code != 0 {
		t.Fatalf("setup exited %d: %s", code, output.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills", agentSkillName, "SKILL.md")); err != nil {
		t.Fatalf("Claude skill missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".gemini", "GEMINI.md")); err == nil {
		t.Fatal("Gemini was set up after answering no")
	}
	// Rerunning must not duplicate the block.
	if code := runAgentIn([]string{"setup", "--yes"}, home, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("second setup exited %d", code)
	}
	data, _ := os.ReadFile(codexFile)
	if strings.Count(string(data), agentBlockBegin) != 1 || !strings.HasPrefix(string(data), "# Mine\n\nKeep this.\n\n") {
		t.Fatalf("unexpected Codex file:\n%s", data)
	}
	if code := runAgentIn([]string{"remove"}, home, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("remove exited %d", code)
	}
	data, _ = os.ReadFile(codexFile)
	if string(data) != "# Mine\n\nKeep this.\n" {
		t.Fatalf("remove left %q", data)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills", agentSkillName)); err == nil {
		t.Fatal("Claude skill still present after remove")
	}
}

func TestAgentSetupStopsWithoutInput(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	if code := runAgentIn([]string{"setup"}, home, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills")); err == nil {
		t.Fatal("wrote a skill with no answer")
	}
}

func TestAgentInstructionsOfferPairedDeviceChoice(t *testing.T) {
	for name, instructions := range map[string]string{"skill": agentSkill, "global note": agentBlock} {
		for _, required := range []string{"cdx devices --json", "request_user_input", "--to", "multiple", "APK"} {
			if !strings.Contains(instructions, required) {
				t.Errorf("%s omits %q", name, required)
			}
		}
	}
}
