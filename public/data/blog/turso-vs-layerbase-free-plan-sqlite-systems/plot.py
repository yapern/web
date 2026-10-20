"""Generate publication charts from the sanitized benchmark report snapshots."""

import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


HERE = Path(__file__).resolve().parent
SLUG = "turso-vs-layerbase-free-plan-sqlite-systems"
IMAGE_DIR = HERE / "figures"
LAYERBASE_REPORT = HERE / "2026-10-20T18-14-10-474Z-6290593e.json"
TURSO_REPORT = HERE / "2026-10-20T04-17-22-531Z-11303e64.json"

PAPER = "#f7f4ec"
INK = "#1e302e"
MUTED = "#556762"
GRID = "#ded9cd"
TURSO = "#168a82"
LAYERBASE = "#c65b35"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "text.color": INK,
    "axes.labelcolor": INK,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "axes.edgecolor": GRID,
    "axes.titlecolor": INK,
    "figure.facecolor": PAPER,
    "axes.facecolor": PAPER,
    "savefig.facecolor": PAPER,
})


def read_report(path):
    return json.loads(path.read_text())


def ramp_points(report, workload):
    points = []
    for stage in report["stages"]:
        warmup = stage.get("warmup") or {}
        if (
            stage.get("name") == workload
            and stage.get("confirmation") is False
            and stage.get("requestedDurationSeconds") == 8
            and stage.get("elapsedSeconds", 0) >= 8
            and stage.get("errors") == 0
            and warmup.get("errors") == 0
            and stage.get("stopReason") is None
        ):
            points.append((stage["concurrency"], stage["successfulRequestsPerSecond"]))
    return sorted(points)


def style_axis(ax):
    ax.grid(axis="y", color=GRID, linewidth=1, zorder=0)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(axis="both", length=0, pad=8)
    ax.set_axisbelow(True)
    ax.set_ylim(bottom=0)


def draw_ramp_panel(ax, title, layerbase, turso, xticks, mobile=False):
    for points, color, marker, linestyle, label in (
        (turso, TURSO, "s", "-", "Turso"),
        (layerbase, LAYERBASE, "o", "--", "Layerbase"),
    ):
        if points:
            xs, ys = zip(*points)
            ax.plot(xs, ys, color=color, marker=marker, linestyle=linestyle,
                    linewidth=3 if mobile else 2.5, markersize=9 if mobile else 8,
                    markeredgewidth=1.5, markeredgecolor=PAPER, label=label, zorder=3)
    ax.set_title(title, loc="left", fontsize=23 if mobile else 21, fontweight="bold", pad=16)
    ax.set_xlabel("Concurrent workers", fontsize=18 if mobile else 15, labelpad=11)
    ax.set_ylabel("Successful SQL requests / s", fontsize=18 if mobile else 14, labelpad=10)
    ax.set_xticks(xticks)
    ax.tick_params(labelsize=18 if mobile else 12)
    style_axis(ax)


def make_plateau(layerbase_report, turso_report):
    layerbase_read = ramp_points(layerbase_report, "point_read")
    turso_read = ramp_points(turso_report, "point_read")
    layerbase_insert = ramp_points(layerbase_report, "single_insert")
    turso_insert = ramp_points(turso_report, "single_insert")
    assert [x for x, _ in layerbase_read] == [1, 8, 32, 64]
    assert [x for x, _ in turso_read] == [1, 8, 32, 64, 128]
    assert [x for x, _ in layerbase_insert] == [1, 8, 32, 64, 128]
    assert [x for x, _ in turso_insert] == [1, 8, 32, 64, 128]

    fig, axes = plt.subplots(1, 2, figsize=(14.4, 7.0), dpi=100)
    fig.text(0.075, 0.955, "Reads scale; writes diverge", fontsize=27,
             fontweight="bold", color=INK, va="top")
    fig.text(0.075, 0.902, "8s clean ramps · Layerbase retest Oct 20 · original Turso results", fontsize=15,
             color=MUTED, va="top")
    handles = [
        plt.Line2D([], [], color=TURSO, marker="s", linestyle="-", linewidth=2.5, label="Turso"),
        plt.Line2D([], [], color=LAYERBASE, marker="o", linestyle="--", linewidth=2.5, label="Layerbase"),
    ]
    labels = ["Turso", "Layerbase"]
    fig.legend(handles, labels, loc="upper right", bbox_to_anchor=(0.95, 0.94),
               ncol=2, frameon=False, fontsize=15, handlelength=2.5,
               columnspacing=1.8, labelcolor=INK)
    draw_ramp_panel(axes[0], "Point lookup", layerbase_read, turso_read,
                    [1, 8, 32, 64, 128])
    draw_ramp_panel(axes[1], "Single-row insert", layerbase_insert, turso_insert,
                    [1, 8, 32, 64, 128])
    axes[0].set_ylim(0, 1700)
    axes[1].set_ylim(0, 180)
    fig.subplots_adjust(left=0.08, right=0.97, top=0.79, bottom=0.16, wspace=0.27)
    fig.savefig(IMAGE_DIR / "read-versus-write-plateau.png", dpi=100)
    plt.close(fig)

    fig, axes = plt.subplots(2, 1, figsize=(7.2, 10.0), dpi=100)
    fig.text(0.10, 0.973, "Reads scale; writes diverge", fontsize=23,
             fontweight="bold", color=INK, va="top")
    fig.text(0.10, 0.939, "8s clean ramps · Layerbase retest Oct 20", fontsize=15,
             color=MUTED, va="top")
    handles = [
        plt.Line2D([], [], color=TURSO, marker="s", linestyle="-", linewidth=3, label="Turso"),
        plt.Line2D([], [], color=LAYERBASE, marker="o", linestyle="--", linewidth=3, label="Layerbase"),
    ]
    labels = ["Turso", "Layerbase"]
    fig.legend(handles, labels, loc="upper left", bbox_to_anchor=(0.10, 0.885),
               ncol=2, frameon=False, fontsize=18, handlelength=2.4,
               columnspacing=1.8, labelcolor=INK)
    draw_ramp_panel(axes[0], "Point lookup", layerbase_read, turso_read,
                    [1, 32, 64, 128], mobile=True)
    draw_ramp_panel(axes[1], "Single-row insert", layerbase_insert, turso_insert,
                    [1, 32, 64, 128], mobile=True)
    axes[0].set_ylim(0, 1700)
    axes[1].set_ylim(0, 180)
    fig.subplots_adjust(left=0.18, right=0.96, top=0.78, bottom=0.08, hspace=0.43)
    fig.savefig(IMAGE_DIR / "read-versus-write-plateau-mobile.png", dpi=100)
    plt.close(fig)


def confirmation(report, workload, concurrency):
    matches = [stage for stage in report["stages"] if
               stage.get("name") == workload
               and stage.get("confirmation") is True
               and stage.get("requestedDurationSeconds") == 20
               and stage.get("concurrency") == concurrency
               and stage.get("errors") == 0
               and (stage.get("warmup") or {}).get("errors") == 0]
    assert len(matches) == 1, (workload, concurrency, len(matches))
    return matches[0]


def bar_panel(ax, values, title, xlabel, xmax, mobile=False):
    labels = ["Single-row insert\n1 row / request", "Batch insert\n100 rows / request"]
    colors = [TURSO, TURSO]
    y = np.arange(2)
    bars = ax.barh(y, values, height=0.52, color=colors, zorder=3)
    ax.set_yticks(y, labels=labels)
    ax.invert_yaxis()
    ax.set_xlim(0, xmax)
    ax.set_title(title, loc="left", fontsize=22 if mobile else 19,
                 fontweight="bold", pad=16)
    ax.set_xlabel(xlabel, fontsize=18 if mobile else 14, labelpad=11)
    ax.tick_params(axis="y", labelsize=17 if mobile else 12, pad=9)
    ax.tick_params(axis="x", labelsize=16 if mobile else 12)
    ax.grid(axis="x", color=GRID, linewidth=1, zorder=0)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(length=0)
    ax.set_axisbelow(True)
    for bar, value in zip(bars, values):
        ax.text(value + xmax * 0.018, bar.get_y() + bar.get_height() / 2,
                f"{value:,.2f}", va="center", ha="left", fontsize=18 if mobile else 14,
                fontweight="bold", color=INK)


def make_batch_comparison(turso_report):
    single = confirmation(turso_report, "single_insert", 64)
    batch = confirmation(turso_report, "batch_insert_100_rows", 16)
    single_requests = single["successfulRequestsPerSecond"]
    batch_requests = batch["successfulRequestsPerSecond"]
    single_rows = single["rowsWritten"] / single["elapsedSeconds"]
    batch_rows = batch["rowsWritten"] / batch["elapsedSeconds"]
    assert round(single_requests, 2) == 55.09
    assert round(batch_requests, 2) == 41.69
    assert round(single_rows, 2) == 55.09
    assert round(batch_rows, 2) == 4168.66

    fig, axes = plt.subplots(1, 2, figsize=(14.4, 5.6), dpi=100)
    fig.text(0.075, 0.955, "Batching lifts row throughput", fontsize=26,
             fontweight="bold", color=INK, va="top")
    fig.text(0.075, 0.900, "Turso · 20s zero-error confirmations · 100 rows per batch statement",
             fontsize=15, color=MUTED, va="top")
    bar_panel(axes[0], [single_requests, batch_requests], "SQL requests", "Successful requests / s", 68)
    bar_panel(axes[1], [single_rows, batch_rows], "Inserted rows", "Rows / s", 5500)
    fig.subplots_adjust(left=0.18, right=0.97, top=0.74, bottom=0.20, wspace=0.40)
    fig.savefig(IMAGE_DIR / "batch-vs-single.png", dpi=100)
    plt.close(fig)

    fig, axes = plt.subplots(2, 1, figsize=(7.2, 8.4), dpi=100)
    fig.text(0.10, 0.970, "Batching lifts row throughput", fontsize=21,
             fontweight="bold", color=INK, va="top")
    fig.text(0.10, 0.929, "Turso · 20s zero-error confirmations · 100 rows per batch statement",
             fontsize=13, color=MUTED, va="top")
    bar_panel(axes[0], [single_requests, batch_requests], "SQL requests", "Successful requests / s", 68, mobile=True)
    bar_panel(axes[1], [single_rows, batch_rows], "Inserted rows", "Rows / s", 5500, mobile=True)
    fig.subplots_adjust(left=0.34, right=0.94, top=0.84, bottom=0.07, hspace=0.58)
    fig.savefig(IMAGE_DIR / "batch-vs-single-mobile.png", dpi=100)
    plt.close(fig)


def main():
    global IMAGE_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=IMAGE_DIR,
                        help="Output directory (default: figures beside this script)")
    IMAGE_DIR = parser.parse_args().output_dir.resolve()
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    layerbase = read_report(LAYERBASE_REPORT)
    turso = read_report(TURSO_REPORT)
    make_plateau(layerbase, turso)
    make_batch_comparison(turso)


if __name__ == "__main__":
    main()
