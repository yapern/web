"""Original explanatory figures; run with matplotlib and Pillow installed.

Sleep means: Tang et al. (2026), Results, NEUSLeeP-enabled STN-FUS enhances
REM sleep performance. https://doi.org/10.1038/s41467-026-73787-6
These are reported pooled means for 26 usable paired recordings. No raw
participant observations, paired-effect intervals, or new measurements are
represented. The study always used sham first and stimulation second.

Ring dimensions: authors' BeamProfileSkull.m at commit
baa5d8bbfba157ea4996a239b4ee2b66294bfc0e in kevintang725/DARPA-NEUSLEEP.
The section's propagation paths are schematic, not simulated or measured.
The ring front view uses the published source's inner and outer diameters.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Rectangle, Wedge


OUT = Path(__file__).resolve().parents[3] / "images/blog/should-you-make-your-own-rem-sleep-patch"
OUT.mkdir(parents=True, exist_ok=True)
PAPER = "#f7f4ee"
INK = "#252b35"
MUTED = "#505968"
GRID = "#d4d1cb"
SHAM = "#69798a"
FUS = "#6b43a6"
COPPER = "#995126"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 15,
    "text.color": INK, "axes.labelcolor": MUTED,
    "xtick.color": MUTED, "ytick.color": INK,
    "svg.fonttype": "none", "figure.facecolor": PAPER,
    "axes.facecolor": PAPER, "savefig.facecolor": PAPER,
})


def save(fig, name, png=False):
    svg_path = OUT / f"{name}.svg"
    fig.savefig(svg_path, metadata={"Date": None})
    # Keep text selectable and supply browser fonts when DejaVu is unavailable.
    svg_path.write_text(svg_path.read_text().replace(
        "font-family: 'DejaVu Sans'", "font-family: 'DejaVu Sans', Arial, sans-serif"))
    if png:
        fig.savefig(OUT / f"{name}.png", dpi=150)
    plt.close(fig)


def sleep_chart(mobile=False):
    fig = plt.figure(figsize=(4.2, 6.5) if mobile else (9.6, 5.4), dpi=100)
    fig.text(.075 if mobile else .055, .935, "Two nights, in a fixed order", fontsize=18 if mobile else 24, weight="bold")
    fig.text(.075 if mobile else .055, .885, "26 usable recordings · reported group means", fontsize=11.5 if mobile else 15, color=MUTED)
    positions = [(0.09, .57, .79, .20), (.09, .18, .79, .20)] if mobile else [(0.065, .26, .38, .42), (.565, .26, .38, .42)]
    panels = [
        ("REM share of sleep", [16.3, 20.9], 30, [0, 10, 20, 30], "%", ["16.3%", "20.9%"]),
        ("Time from sleep onset to REM", [177, 134.7], 240, [0, 60, 120, 180, 240], "minutes", ["177 min", "134.7 min"]),
    ]
    for pos, (title, means, limit, ticks, unit, labels) in zip(positions, panels):
        ax = fig.add_axes(pos)
        ax.set_title(title, loc="left", pad=20 if mobile else 30, fontsize=13 if mobile else 17, weight="bold")
        for y, value, label, color, night in zip([1, 0], means, labels, [SHAM, FUS], ["Night 1 · sham", "Night 2 · ultrasound"]):
            ax.barh(y, value, height=.24, color=color, zorder=3)
            ax.text(0, y+.23, night, fontsize=11 if mobile else 13, va="bottom")
            ax.text(value + limit*.025, y, label, fontsize=11 if mobile else 14, va="center", weight="bold")
        ax.set_xlim(0, limit)
        ax.set_ylim(-.35, 1.6)
        ax.set_yticks([])
        ax.set_xticks(ticks, [f"{v}" for v in ticks], fontsize=10 if mobile else 13)
        ax.set_xlabel(unit, fontsize=11 if mobile else 13, labelpad=7)
        ax.grid(axis="x", color=GRID, linewidth=.8, zorder=0)
        ax.spines[["top", "left", "right"]].set_visible(False)
        ax.spines["bottom"].set_color(GRID)
        ax.tick_params(axis="x", length=0, pad=8)
    fig.text(.075 if mobile else .055, .04 if mobile else .09,
             "Means only; individual responses and\nuncertainty intervals are not shown." if mobile else "Means only; individual responses and uncertainty intervals are not shown.",
             fontsize=10.5 if mobile else 13, color=MUTED, linespacing=1.5)
    save(fig, "sleep-results-mobile" if mobile else "sleep-results")


def ring_chart(mobile=False):
    fig = plt.figure(figsize=(4.2, 6.8) if mobile else (9.6, 5.4), dpi=100)
    fig.text(.075 if mobile else .055, .94, "Eight rings, one shared focus", fontsize=18 if mobile else 24, weight="bold")
    fig.text(.075 if mobile else .055, .895, "Geometry and timing in a simplified water model", fontsize=10.5 if mobile else 15, color=MUTED)
    front_pos = [.11, .48, .78, .34] if mobile else [.055, .19, .35, .58]
    side_pos = [.095, .12, .84, .265] if mobile else [.49, .19, .47, .58]
    front = fig.add_axes(front_pos)
    side = fig.add_axes(side_pos)
    inner = [5.35, 10.72, 16.07, 21.43, 26.79, 32.15, 37.51, 42.86]
    outer = [10.07, 15.42, 20.78, 26.14, 31.49, 36.86, 42.21, 47.57]
    for i, (di, do) in enumerate(zip(inner, outer)):
        colour = FUS if i == 0 else COPPER
        front.add_patch(Wedge((0, 0), do/2, 0, 360, width=(do-di)/2, facecolor=colour, edgecolor="none"))
    front.plot([-27, 27], [0, 0], color=MUTED, lw=.8, ls=(0, (3, 4)))
    front.set_xlim(-29, 29)
    front.set_ylim(-28, 28)
    front.set_aspect("equal")
    front.set_title("Front view", loc="left", fontsize=13 if mobile else 16, pad=12, weight="bold")
    front.axis("off")

    # Distance in the side view is illustrative; it is not an anatomical depth.
    focal_x = 64
    for i, (di, do) in enumerate(zip(inner, outer)):
        colour = FUS if i == 0 else COPPER
        for sign in [-1, 1]:
            low, high = sorted([sign*di/2, sign*do/2])
            side.add_patch(Rectangle((-1, low), 2.6, high-low, facecolor=colour, zorder=4))
            if i in [0, 7]:
                mid = sign*(di+do)/4
                side.plot([1.6, focal_x], [mid, 0], color=colour, lw=1.9, ls="-" if i == 0 else (0, (5, 3)), zorder=2)
    side.plot([-5, focal_x+6], [0, 0], color=MUTED, lw=.8, ls=(0, (2, 4)), zorder=1)
    side.add_patch(Circle((focal_x, 0), 1.4, facecolor=INK, zorder=5))
    side.text(focal_x-1, -6, "Focus", fontsize=11 if mobile else 14, ha="center")
    side.text(20, 21, "Outer ring: longer path", color=COPPER, fontsize=10 if mobile else 13)
    side.text(1, -33, "Inner ring: shorter path", color=FUS, fontsize=10 if mobile else 13)
    side.set_title("Section through the center", loc="left", fontsize=13 if mobile else 16, pad=12, weight="bold")
    side.set_xlim(-5, 77)
    side.set_ylim(-38, 31)
    side.set_aspect("equal")
    side.axis("off")
    fig.text(.075 if mobile else .055, .035 if mobile else .09,
             "Relative timing aligns arrivals at the focus.\nPaths are schematic, not a measured beam." if mobile else "Relative timing aligns arrivals at the focus. Paths are schematic, not a measured beam.",
             fontsize=10.5 if mobile else 13, color=MUTED, linespacing=1.5)
    save(fig, "concentric-array-mobile" if mobile else "concentric-array", png=not mobile)


if __name__ == "__main__":
    sleep_chart()
    sleep_chart(mobile=True)
    ring_chart()
    ring_chart(mobile=True)
