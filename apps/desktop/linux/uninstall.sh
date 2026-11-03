#!/bin/sh
set -eu
exec "$(dirname "$0")/ra2commander" --uninstall
