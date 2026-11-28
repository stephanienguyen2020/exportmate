"""The Order features job's entry point (the image's ENTRYPOINT): `--measure` scores the trade measures
the news scan wrote down with the harshness model (`harshness_scoring.py`); anything else is the trade
risk run (`order_features.py`), with its own arguments."""

import sys

from trade_risk import harshness_scoring, order_features


def main() -> None:
    if any(arg == "--measure" or arg.startswith("--measure=") for arg in sys.argv[1:]):
        harshness_scoring.main()
    else:
        order_features.main()


if __name__ == "__main__":
    main()
