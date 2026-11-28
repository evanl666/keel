"""Keel: an open-source AI steward for every team."""

import importlib.metadata

try:
    __version__ = importlib.metadata.version("keel-steward")
except importlib.metadata.PackageNotFoundError:  # running from a source tree without an install
    __version__ = "0.2.0"
