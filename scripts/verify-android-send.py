"""Verify a synthetic foreground send on an explicitly selected emulator.

Requires installed debug and androidTest APKs, a local relay, and a built cdx.
Never prints the private invitation. Uses only the selected emulator.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "evidence" / "android-send"
WORK.mkdir(parents=True, exist_ok=True)
SERIAL = os.environ.get("CD_VERIFY_ANDROID_SERIAL", "")
assert re.fullmatch(r"emulator-\d+", SERIAL), "Select an emulator with CD_VERIFY_ANDROID_SERIAL"
ADB = [os.environ.get("ADB", str(Path(os.environ.get("ANDROID_HOME", "/opt/android-sdk")) / "platform-tools" / "adb")), "-s", SERIAL]
PACKAGE = os.environ.get("CD_VERIFY_PACKAGE", "in.yash0.cd")
BASE = os.environ.get("CD_VERIFY_PUBLIC_URL", "http://127.0.0.1:8797")
assert re.fullmatch(r"http://127\.0\.0\.1:\d+", BASE), "This check requires a local relay"
CLI = Path(os.environ.get("CD_VERIFY_CLI", str(ROOT / "evidence" / "cdx")))


def adb(*args):
    return subprocess.check_output(ADB + list(args), stderr=subprocess.PIPE, timeout=60).decode().strip()


def status():
    try:
        return json.loads(adb("shell", "run-as", PACKAGE, "cat", "files/send-test-status.json"))
    except (subprocess.CalledProcessError, ValueError):
        return {}


def wait_status(predicate, seconds=300):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = status()
        if predicate(value):
            return value
        time.sleep(0.15)
    value = status()
    raise AssertionError(f"Timed out at {value.get('phase')}: {value.get('message')}")


def instrument(action, label, transfer_id=None):
    adb("shell", "run-as", PACKAGE, "rm", "-f", "files/send-test-status.json", "files/send-test-tree.xml")
    args = ["shell", "am", "instrument", "-w", "-e", "action", action,
            "-e", "source", "/data/local/tmp/cd-send-verify.bin", "-e", "base", BASE]
    if transfer_id:
        args += ["-e", "id", transfer_id]
    log = (WORK / f"{label}.log").open("w")
    return subprocess.Popen(ADB + args + [f"{PACKAGE}.test/in.yash0.cd.SendInstrumentation"], stdout=log, stderr=subprocess.STDOUT)


def tree():
    # Instrumentation exports the live accessibility tree without waiting for
    # animation idle. Retry only missing/incomplete exports during recreation.
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            return ET.fromstring(adb("shell", "run-as", PACKAGE, "cat", "files/send-test-tree.xml"))
        except (subprocess.CalledProcessError, ET.ParseError):
            time.sleep(0.25)
    raise AssertionError("Instrumentation did not export an accessibility tree")


def tap_text(text):
    deadline = time.monotonic() + 60
    nodes = []
    while time.monotonic() < deadline:
        nodes = [n for n in tree().iter("node") if n.get("text") == text or n.get("content-desc") == text]
        if nodes:
            break
        time.sleep(0.25)
    assert nodes, f"Missing UI control {text}"
    bounds = list(map(int, re.findall(r"\d+", nodes[-1].get("bounds"))))
    adb("shell", "input", "tap", str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2))
    time.sleep(1.0)


def qr_visible():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if any("QR code that opens this transfer" in n.get("content-desc", "") for n in tree().iter("node")):
            return True
        time.sleep(0.25)
    return False


def screenshot(label):
    with (WORK / f"{label}.png").open("wb") as output:
        subprocess.run(ADB + ["exec-out", "screencap", "-p"], stdout=output, check=True, timeout=60)


def assert_qr_pixels(label, invitation):
    from PIL import Image
    picture = Image.open(WORK / f"{label}.png").convert("RGBA")
    js = "const fs=require('fs'),decode=require(process.argv[1]);const p=decode(new Uint8ClampedArray(fs.readFileSync(0)),Number(process.argv[2]),Number(process.argv[3]));process.stdout.write(p?.data||'');"
    module = os.environ.get("CD_VERIFY_JSQR_MODULE", "jsqr")
    decoded = subprocess.check_output(["node", "-e", js, module, str(picture.width), str(picture.height)], input=picture.tobytes(), timeout=30).decode()
    assert decoded == invitation, "Displayed QR pixels do not decode to the accepted invitation"


assert adb("shell", "getprop", "ro.kernel.qemu") == "1", "Tests require an emulator"
port = BASE.rsplit(":", 1)[1]
adb("reverse", f"tcp:{port}", f"tcp:{port}")
source = WORK / "source.bin"
source.write_bytes(os.urandom(32 * 1024 * 1024))
expected = hashlib.sha256(source.read_bytes()).hexdigest()
adb("push", str(source), "/data/local/tmp/cd-send-verify.bin")
app = None
receiver = None
rotation = adb("shell", "settings", "get", "system", "user_rotation")
automatic_rotation = adb("shell", "settings", "get", "system", "accelerometer_rotation")
try:
    app = instrument("start", "start")
    ready = wait_status(lambda v: v.get("phase") == "WAITING")
    invitation = ready.get("link")
    assert invitation and "#v2." in invitation, "Accepted sender has no v2 invitation"
    transfer_id = ready["id"]
    tap_text("Transfers")
    tap_text("cd-send-verify.bin")
    assert qr_visible(), "Accepted sender does not show QR"
    screenshot("waiting")
    assert_qr_pixels("waiting", invitation)
    width, height = map(int, re.search(r"(\d+)x(\d+)", adb("shell", "wm", "size")).groups())
    x = str(width // 2)
    adb("shell", "input", "swipe", x, str(int(height * .70)), x, str(int(height * .30)), "400")
    adb("shell", "input", "swipe", x, str(int(height * .30)), x, str(int(height * .70)), "400")
    assert qr_visible(), "QR disappeared after scrolling back"
    assert status().get("link") == invitation, "Scrolling changed the invitation"
    screenshot("after-scroll")
    assert_qr_pixels("after-scroll", invitation)
    adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
    before_recreation = status().get("activityCreates", 0)
    adb("shell", "settings", "put", "system", "user_rotation", "1")
    wait_status(lambda v: v.get("activityCreates", 0) > before_recreation)
    time.sleep(1)
    assert qr_visible(), "Activity recreation lost the transfer screen"
    before_recreation = status().get("activityCreates", 0)
    adb("shell", "settings", "put", "system", "user_rotation", "0")
    wait_status(lambda v: v.get("activityCreates", 0) > before_recreation)
    time.sleep(1)
    assert qr_visible(), "Returning to portrait lost the transfer screen"
    screenshot("after-recreation")
    adb("shell", "am", "force-stop", PACKAGE)
    app.wait(timeout=30)
    app = instrument("resume", "resume", transfer_id)
    resumed = wait_status(lambda v: v.get("phase") == "WAITING")
    assert resumed.get("link") == invitation, "Restart/resume changed the invitation"
    output = WORK / "received.bin"
    with (WORK / "receiver-interrupted.log").open("w") as log:
        receiver = subprocess.Popen([str(CLI), "receive", "--json", "--progress", "--out", str(output), invitation],
                                    env={**os.environ, "CD_PUBLIC_URL": BASE, "CD_RELAY_URL": BASE.replace("http:", "ws:") + "/ws/v1"},
                                    stdout=log, stderr=subprocess.STDOUT)
        progressed = wait_status(lambda v: v.get("phase") == "TRANSFERRING" and v.get("done", 0) >= 262144)
        retained = progressed["done"]
        # Abrupt loss, not a graceful cancel (cancel deliberately discards CLI checkpoints).
        receiver.kill()
        receiver.wait(timeout=30)
        adb("shell", "am", "force-stop", PACKAGE)
        app.wait(timeout=30)
    time.sleep(2)
    app = instrument("resume", "resume-data", transfer_id)
    resumed = wait_status(lambda v: v.get("phase") == "WAITING")
    assert resumed.get("link") == invitation, "Mid-data restart changed the invitation"
    with (WORK / "receiver.log").open("w") as log:
        receiver = subprocess.Popen([str(CLI), "receive", "--json", "--out", str(output), invitation],
                                    env={**os.environ, "CD_PUBLIC_URL": BASE, "CD_RELAY_URL": BASE.replace("http:", "ws:") + "/ws/v1"},
                                    stdout=log, stderr=subprocess.STDOUT)
        assert receiver.wait(timeout=240) == 0, "CLI receive failed; inspect local receiver.log"
    complete = wait_status(lambda v: v.get("phase") == "COMPLETE")
    assert complete.get("link") is None, "Completed sender still exposes invitation"
    assert hashlib.sha256(output.read_bytes()).hexdigest() == expected, "Received bytes differ"
    received = [json.loads(line) for line in (WORK / "receiver.log").read_text().splitlines() if line.startswith("{")]
    assert any(value.get("resumedBytes", 0) >= retained for value in received), "Receiver did not resume retained acknowledged bytes"
    app.wait(timeout=30)
    summary = {"result": "passed", "bytes": source.stat().st_size, "sha256": expected,
               "checks": ["accepted v2 QR and decoded pixels", "scroll down/back and decoded pixels", "stable invitation", "Activity recreation",
                          "process interruption while waiting",
                          "explicit resume with same invitation", "mid-data process interruption", "verified retained-prefix resume", "CLI receive SHA-256", "completion hides invitation"]}
    (WORK / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
finally:
    for process in (receiver, app):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
    # A platform restart must not mask the original test assertion with cleanup errors.
    cleanup = [["shell", "am", "force-stop", PACKAGE]]
    for setting, value in (("user_rotation", rotation), ("accelerometer_rotation", automatic_rotation)):
        cleanup.append(["shell", "settings", "delete", "system", setting] if value == "null" else
                       ["shell", "settings", "put", "system", setting, value])
    cleanup.append(["shell", "rm", "-f", "/data/local/tmp/cd-send-verify.bin"])
    for command in cleanup:
        try:
            subprocess.run(ADB + command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except subprocess.TimeoutExpired:
            pass
    source.unlink(missing_ok=True)
    (WORK / "received.bin").unlink(missing_ok=True)
