#!/usr/bin/env python3
"""Verify the pinned WebRTC artifact and optionally its publisher's raw release AAR."""
import argparse
import hashlib
import io
from pathlib import Path
import zipfile

VERSION = "150.7871.01"
MAVEN_SHA256 = "0a1627b1a48c2bc17d9a40d62fc47bd45166f44a311e95917f147c402de379b0"
RELEASE_SHA256 = "8ad5e5fd02f0177743ddb566bea329006bef7689b944f6351717cd1d018958c0"
NATIVE_SHA256 = {
    "armeabi-v7a": "762f3d5e1c4c69c3f02f2383540f40e1142cb631e9d99e86bdb1602f4c277559",
    "arm64-v8a": "7b299113fcd743de7dc5559686b21fc2681b2c8598347d8dc0743d2e004995ca",
    "x86_64": "0717afcc43da0c1aabd904f9ef0653efc8f3d37b5750f39a123697e7910b623a",
    "x86": "80e7b1b7e07bb5a53841a8cacabf942a6f3eb8ee9759a1731741dd912f367f19",
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("aar", type=Path, nargs="?")
parser.add_argument("--release-aar", type=Path)
args = parser.parse_args()
if args.aar is None:
    matches = list((Path.home() / ".gradle/caches/modules-2/files-2.1/io.github.webrtc-sdk/android" / VERSION).glob("*/*.aar"))
    if len(matches) != 1:
        parser.error("Pass the Maven AAR path, or resolve it with ./gradlew :app:assembleDebug first")
    args.aar = matches[0]
assert hashlib.sha256(args.aar.read_bytes()).hexdigest() == MAVEN_SHA256, "Maven AAR digest mismatch"
with zipfile.ZipFile(args.aar) as maven:
    for abi, digest in NATIVE_SHA256.items():
        assert hashlib.sha256(maven.read(f"jni/{abi}/libjingle_peerconnection_so.so")).hexdigest() == digest, f"Native library mismatch: {abi}"
    if args.release_aar:
        assert hashlib.sha256(args.release_aar.read_bytes()).hexdigest() == RELEASE_SHA256, "Publisher release digest mismatch"
        with zipfile.ZipFile(args.release_aar) as release:
            assert set(maven.namelist()) == set(release.namelist())
            for name in maven.namelist():
                if name != "classes.jar":
                    assert maven.read(name) == release.read(name), f"Changed release entry: {name}"
            with zipfile.ZipFile(io.BytesIO(maven.read("classes.jar"))) as compiled, zipfile.ZipFile(io.BytesIO(release.read("classes.jar"))) as original:
                assert set(compiled.namelist()) == set(original.namelist())
                for name in original.namelist():
                    data = original.read(name)
                    if name.endswith(".class") and data[:4] == b"\xca\xfe\xba\xbe" and int.from_bytes(data[6:8], "big") > 61:
                        data = data[:6] + (61).to_bytes(2, "big") + data[8:]
                    assert compiled.read(name) == data, f"Unexpected Java transformation: {name}"
print(f"Verified WebRTC {VERSION}: Maven AAR, all native ABIs" + (", and publisher release transformation" if args.release_aar else ""))
