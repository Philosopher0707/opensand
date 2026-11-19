# Free-space volume selection shared by the disk guards.
#
# `df -k /` on macOS reports the read-only system snapshot (/dev/disk3s1s1), not the
# writable data volume, so the reported free space is wrong. Measure /System/Volumes/Data
# when it exists; on Linux CI there is no such mount, so fall back to $HOME.
if [[ -d /System/Volumes/Data ]]; then
  DISK_PATH="/System/Volumes/Data"
else
  DISK_PATH="$HOME"
fi
