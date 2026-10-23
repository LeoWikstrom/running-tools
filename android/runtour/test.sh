#!/usr/bin/env bash
# Replays the golden traces exported by packages/core/test/runtime.test.ts
# against the Java runtime, on the plain JVM. Fails on any mismatch.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/jvm
javac -d build/jvm src/se/leo/runtour/RunRuntime.java src/se/leo/runtour/RuntimeCheck.java
java -cp build/jvm se.leo.runtour.RuntimeCheck test/runtime-cases.txt
