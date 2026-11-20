import numpy as np
import pytest

from ncbio import signals

T = np.arange(120) / 60.0


def test_runs_finds_each_stretch():
    assert signals.runs(np.array([1, 1, 0, 1, 0, 0, 1], bool)) == [(0, 2), (3, 4), (6, 7)]
    assert signals.runs(np.zeros(3, bool)) == []


def test_short_gaps_are_filled_long_gaps_and_ends_are_not():
    x = np.sin(T)
    x[10:14] = np.nan  # 4 frames ≈ 0.08 s
    x[40:70] = np.nan  # 0.5 s
    x[:3] = np.nan
    y = signals.fill_gaps(x, T, 0.25)
    assert np.isfinite(y[10:14]).all()
    assert y[12] == pytest.approx(np.sin(T[12]), abs=1e-3)
    assert np.isnan(y[40:70]).all()
    assert np.isnan(y[:3]).all()


def test_smoothing_keeps_gaps_and_removes_noise():
    rng = np.random.default_rng(1)
    clean = np.sin(2 * np.pi * T)
    x = clean + rng.normal(0, 0.05, T.size)
    x[50:90] = np.nan
    y = signals.smooth(x, T)
    assert np.isnan(y[50:90]).all()
    ok = np.isfinite(y)
    assert np.std(y[ok] - clean[ok]) < np.std(x[ok] - clean[ok])


def test_cycles_split_at_minima_and_skip_gaps():
    t = np.arange(600) / 60.0
    x = 1 - np.cos(2 * np.pi * 2 * t)  # 2 Hz, minima every 0.5 s
    assert len(signals.cycles(x, t)) == 18  # 19 interior minima
    x[290:300] = np.nan
    cyc = signals.cycles(x, t)
    assert all(not (a < 295 < b) for a, b in cyc)
    assert len(signals.cycles(np.zeros(600), t)) == 0


def test_reference_length_is_the_median_over_found_frames():
    a = np.zeros((5, 3))
    b = np.array([[3, 4, 0], [6, 8, 0], [3, 4, 0], [np.nan] * 3, [3, 4, 0]], float)
    assert signals.reference_length(a, b) == 5.0
    assert np.isnan(signals.reference_length(a, np.full((5, 3), np.nan)))


def test_asymmetry():
    assert signals.asym(3.0, 1.0) == 0.5
    assert signals.asym(1.0, 1.0) == 0.0
    assert signals.asym(None, 1.0) is None
    assert signals.asym(0.0, 0.0) is None


def test_fps():
    assert signals.fps_of(T) == pytest.approx(60.0)
    assert signals.fps_of(np.array([0.0])) == 0.0
