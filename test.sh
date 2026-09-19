#!/bin/zsh
# Runs the unit tests with the Command Line Tools' Swift Testing framework (no Xcode needed).
set -e
cd "$(dirname "$0")"
F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
L=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
swift test -Xswiftc -F$F -Xlinker -F$F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $L "$@" 2>&1 | grep -E "✘|✔ Suite|Test run|error:" || true
