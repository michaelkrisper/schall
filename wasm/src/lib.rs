//! DSP core of Schall, compiled to WebAssembly with SIMD128. Runs inside the
//! AudioWorklet: a sound level meter (A/C/Z frequency weighting, Fast/Slow time
//! weighting) and a real FFT spectrum analyser with averaging. No std, no
//! allocation; every buffer is static and shared with JavaScript by pointer.
//!
//! Levels and spectra are power relative to digital full scale, scaled so a
//! sine wave reads its RMS level (full-scale sine = 0.5, i.e. -3 dB). The page
//! adds the calibration offset.

#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const MAX_N: usize = 16384;
const MAX_M: usize = MAX_N / 2;
const MAX_BLOCK: usize = 1024;
const MAX_COLS: usize = 4096;
const REPORT_LEN: usize = 26;

// Blackman-Harris, four terms: sidelobes at -92 dB, so a weak tone next to a
// strong one is not buried in its skirt.
const BH: [f64; 4] = [0.35875, 0.48829, 0.14128, 0.01168];

const ZERO: v128 = f64x2(0.0, 0.0);

#[repr(C, align(16))]
struct State {
    input: [f32; MAX_BLOCK],

    // Level meter. The filters run in f64 (the 20 Hz poles need it) with A and
    // C side by side in one f64x2, Z as a scalar; the statistics then run in
    // f32x4 lanes (A, C, Z, -).
    filters: [f64; 35],
    coef: [v128; 15],
    z1: [v128; 3],
    z2: [v128; 3],
    coef_z: [f64; 5],
    zs: [f64; 2],
    squares: [v128; MAX_BLOCK],
    alpha_fast: f32,
    alpha_slow: f32,
    report_samples: usize,
    n: usize,
    primed: bool,
    sum: v128,
    peak: v128,
    fast: v128,
    slow: v128,
    fast_min: v128,
    fast_max: v128,
    slow_min: v128,
    slow_max: v128,
    report: [f64; REPORT_LEN],
    sample_rate: f64,

    // Spectrum analyser.
    fft_n: usize,
    fft_m: usize,
    hop: usize,
    pos: usize,
    warm: usize,
    scale: f32,
    history: [f32; MAX_N],
    window: [f32; MAX_N],
    re: [f32; MAX_M],
    im: [f32; MAX_M],
    tw_re: [f32; MAX_M],
    tw_im: [f32; MAX_M],
    pt_re: [f32; MAX_M],
    pt_im: [f32; MAX_M],
    bitrev: [u32; MAX_M],
    power: [f32; MAX_M],
    avg_short: [f32; MAX_M],
    avg_long: [f32; MAX_M],
    total: [f64; MAX_M],
    selected: [f32; MAX_M],
    selected_db: [f32; MAX_M],
    frames: f64,
    alpha_short: f32,
    alpha_long: f32,
    spectrum_primed: bool,
    mode: u32,
    cols: usize,
    edges: [f32; 2 * MAX_COLS],
    live_cols: [f32; MAX_COLS],
    avg_cols: [f32; MAX_COLS],
}

// All zero, so it lands in .bss instead of bloating the module; `setup`
// fills in the rest.
static mut STATE: State = State {
    input: [0.0; MAX_BLOCK],
    filters: [0.0; 35],
    coef: [ZERO; 15],
    z1: [ZERO; 3],
    z2: [ZERO; 3],
    coef_z: [0.0; 5],
    zs: [0.0; 2],
    squares: [ZERO; MAX_BLOCK],
    alpha_fast: 0.0,
    alpha_slow: 0.0,
    report_samples: 0,
    n: 0,
    primed: false,
    sum: ZERO,
    peak: ZERO,
    fast: ZERO,
    slow: ZERO,
    fast_min: ZERO,
    fast_max: ZERO,
    slow_min: ZERO,
    slow_max: ZERO,
    report: [0.0; REPORT_LEN],
    sample_rate: 0.0,
    fft_n: 0,
    fft_m: 0,
    hop: 0,
    pos: 0,
    warm: 0,
    scale: 0.0,
    history: [0.0; MAX_N],
    window: [0.0; MAX_N],
    re: [0.0; MAX_M],
    im: [0.0; MAX_M],
    tw_re: [0.0; MAX_M],
    tw_im: [0.0; MAX_M],
    pt_re: [0.0; MAX_M],
    pt_im: [0.0; MAX_M],
    bitrev: [0; MAX_M],
    power: [0.0; MAX_M],
    avg_short: [0.0; MAX_M],
    avg_long: [0.0; MAX_M],
    total: [0.0; MAX_M],
    selected: [0.0; MAX_M],
    selected_db: [0.0; MAX_M],
    frames: 0.0,
    alpha_short: 0.0,
    alpha_long: 0.0,
    spectrum_primed: false,
    mode: 0,
    cols: 0,
    edges: [0.0; 2 * MAX_COLS],
    live_cols: [0.0; MAX_COLS],
    avg_cols: [0.0; MAX_COLS],
};

#[inline(always)]
fn st() -> &'static mut State {
    // Single-threaded: the worklet calls in strictly one after another.
    unsafe { &mut *(&raw mut STATE) }
}

// ---------------------------------------------------------------------------
// Maths without libm.

const PI: f64 = core::f64::consts::PI;

// Taylor series, |x| <= PI: error < 1e-15, plenty for twiddles and windows.
fn sin_cos(x: f64) -> (f64, f64) {
    let x2 = x * x;
    let (mut s, mut ts) = (x, x);
    let (mut c, mut tc) = (1.0, 1.0);
    let mut k = 1.0;
    while k < 24.0 {
        ts *= -x2 / ((2.0 * k) * (2.0 * k + 1.0));
        tc *= -x2 / ((2.0 * k - 1.0) * (2.0 * k));
        s += ts;
        c += tc;
        k += 1.0;
    }
    (s, c)
}

// cos(2π·i/n) for any integer i, reduced exactly in integers first.
fn cos_frac(i: usize, n: usize) -> f64 {
    let mut x = 2.0 * PI * ((i % n) as f64) / n as f64;
    if x > PI {
        x -= 2.0 * PI;
    }
    sin_cos(x).1
}

fn exp_neg(x: f64) -> f64 {
    // e^-x for 0 <= x, by halving until small, Taylor, squaring back.
    let mut y = x;
    let mut halvings = 0;
    while y > 0.125 {
        y *= 0.5;
        halvings += 1;
    }
    let mut term = 1.0;
    let mut sum = 1.0;
    let mut k = 1.0;
    while k < 16.0 {
        term *= -y / k;
        sum += term;
        k += 1.0;
    }
    while halvings > 0 {
        sum *= sum;
        halvings -= 1;
    }
    sum
}

// 10·log10(x) for four powers at once: exponent from the float bits plus an
// atanh series for the mantissa; error below 1e-5 dB. Zero reads -300 dB.
#[inline(always)]
fn db4(x: v128) -> v128 {
    let x = f32x4_max(x, f32x4_splat(1e-30));
    let exponent = f32x4_convert_i32x4(i32x4_sub(u32x4_shr(x, 23), i32x4_splat(127)));
    let mantissa = v128_or(v128_and(x, i32x4_splat(0x007f_ffff)), i32x4_splat(0x3f80_0000));
    let one = f32x4_splat(1.0);
    let t = f32x4_div(f32x4_sub(mantissa, one), f32x4_add(mantissa, one));
    let t2 = f32x4_mul(t, t);
    // ln(m) = 2·(t + t³/3 + t⁵/5 + t⁷/7 + t⁹/9)
    let mut p = f32x4_splat(2.0 / 9.0);
    p = f32x4_add(f32x4_mul(p, t2), f32x4_splat(2.0 / 7.0));
    p = f32x4_add(f32x4_mul(p, t2), f32x4_splat(2.0 / 5.0));
    p = f32x4_add(f32x4_mul(p, t2), f32x4_splat(2.0 / 3.0));
    p = f32x4_add(f32x4_mul(p, t2), f32x4_splat(2.0));
    let ln_m = f32x4_mul(p, t);
    // 10·log10(2) per octave, 10/ln(10) per neper.
    f32x4_add(
        f32x4_mul(exponent, f32x4_splat(3.010_299_956_6)),
        f32x4_mul(ln_m, f32x4_splat(4.342_944_819)),
    )
}

#[inline(always)]
unsafe fn load(p: *const f32) -> v128 {
    unsafe { v128_load(p as *const v128) }
}

#[inline(always)]
unsafe fn store(p: *mut f32, v: v128) {
    unsafe { v128_store(p as *mut v128, v) }
}

// ---------------------------------------------------------------------------
// Exports: buffers.

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut f32 {
    st().input.as_mut_ptr()
}

/// A weighting: 3 biquads, C: 3 (padded with pass-through), Z: 1, each as
/// [b0, b1, b2, a1, a2]. Write before `setup`.
#[unsafe(no_mangle)]
pub extern "C" fn filters_ptr() -> *mut f64 {
    st().filters.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn report_ptr() -> *const f64 {
    st().report.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn edges_ptr() -> *mut f32 {
    st().edges.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn live_ptr() -> *const f32 {
    st().live_cols.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn average_ptr() -> *const f32 {
    st().avg_cols.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn power_ptr() -> *const f32 {
    st().power.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn bins() -> u32 {
    st().fft_m as u32
}

// ---------------------------------------------------------------------------
// Exports: control.

/// Prepares everything for a sample rate. `fft_size` a power of two from 64 to
/// 16384, `hop` the samples between spectra, `report_samples` between level
/// reports. Returns 0, or 1 for an unsupported size.
#[unsafe(no_mangle)]
pub extern "C" fn setup(sample_rate: f64, fft_size: u32, hop: u32, report_samples: u32) -> u32 {
    let s = st();
    let n = fft_size as usize;
    if !n.is_power_of_two() || !(64..=MAX_N).contains(&n) || hop == 0 || hop as usize > n {
        return 1;
    }
    s.sample_rate = sample_rate;

    // Level meter: interleave A and C coefficients into lanes.
    for k in 0..15 {
        s.coef[k] = f64x2(s.filters[k], s.filters[15 + k]);
    }
    s.coef_z.copy_from_slice(&s.filters[30..35]);
    s.z1 = [ZERO; 3];
    s.z2 = [ZERO; 3];
    s.zs = [0.0; 2];
    s.alpha_fast = (1.0 - exp_neg(1.0 / (0.125 * sample_rate))) as f32;
    s.alpha_slow = (1.0 - exp_neg(1.0 / sample_rate)) as f32;
    s.report_samples = report_samples.max(1) as usize;
    s.primed = false;
    clear_report(s);

    // Spectrum analyser.
    let m = n / 2;
    s.fft_n = n;
    s.fft_m = m;
    s.hop = hop as usize;
    s.pos = 0;
    s.warm = 0;
    for i in 0..n {
        let w = BH[0] - BH[1] * cos_frac(i, n) + BH[2] * cos_frac(2 * i, n) - BH[3] * cos_frac(3 * i, n);
        s.window[i] = w as f32;
        s.history[i] = 0.0;
    }
    // |X|² of a sine at a bin centre is (A·N·a0/2)²; its mean square is A²/2.
    let gain = n as f64 * BH[0];
    s.scale = (2.0 / (gain * gain)) as f32;
    let bits = m.trailing_zeros();
    for i in 0..m {
        s.bitrev[i] = if bits == 0 { 0 } else { (i as u32).reverse_bits() >> (32 - bits) };
    }
    // Twiddles of the stage with half-size h at h..2h: e^(-iπj/h).
    let mut h = 1;
    while h < m {
        for j in 0..h {
            let (sin, cos) = sin_cos(-PI * j as f64 / h as f64);
            s.tw_re[h + j] = cos as f32;
            s.tw_im[h + j] = sin as f32;
        }
        h *= 2;
    }
    // Split of the half-size complex FFT into the real one: e^(-2πik/N).
    for k in 0..m {
        let (sin, cos) = sin_cos(-2.0 * PI * k as f64 / n as f64);
        s.pt_re[k] = cos as f32;
        s.pt_im[k] = sin as f32;
    }
    let hop_seconds = hop as f64 / sample_rate;
    s.alpha_short = (1.0 - exp_neg(hop_seconds / 1.0)) as f32;
    s.alpha_long = (1.0 - exp_neg(hop_seconds / 10.0)) as f32;
    reset_spectrum();
    s.cols = 0;
    0
}

/// 0: average over ~1 s, 1: ~10 s, 2: everything since the last reset.
#[unsafe(no_mangle)]
pub extern "C" fn set_mode(mode: u32) {
    st().mode = mode.min(2);
    select_average(st());
}

#[unsafe(no_mangle)]
pub extern "C" fn reset_spectrum() {
    let s = st();
    s.spectrum_primed = false;
    s.frames = 0.0;
    s.total[..s.fft_m].fill(0.0);
}

/// Display columns: write [first, last) as fractional bin positions to
/// `edges_ptr`, two per column. Each column then shows the strongest bin in
/// its range, or a value interpolated between bins where it is narrower.
#[unsafe(no_mangle)]
pub extern "C" fn columns(count: u32) -> u32 {
    let count = count as usize;
    if count > MAX_COLS {
        return 1;
    }
    st().cols = count;
    0
}

/// The selected average at full resolution, in dB.
#[unsafe(no_mangle)]
pub extern "C" fn average_db() -> *const f32 {
    let s = st();
    let m = s.fft_m;
    unsafe {
        let src = s.selected.as_ptr();
        let dst = s.selected_db.as_mut_ptr();
        let mut k = 0;
        while k < m {
            store(dst.add(k), db4(load(src.add(k))));
            k += 4;
        }
    }
    s.selected_db.as_ptr()
}

/// Feeds `count` samples from `input_ptr`. Returns flags: 1 = a level report
/// is ready at `report_ptr`, 2 = a new spectrum is ready at `live_ptr` /
/// `average_ptr`.
#[unsafe(no_mangle)]
pub extern "C" fn process(count: u32) -> u32 {
    let s = st();
    let count = (count as usize).min(MAX_BLOCK);
    let mut flags = 0;
    if level_block(s, count) {
        flags |= 1;
    }
    if spectrum_block(s, count) {
        flags |= 2;
    }
    flags
}

// ---------------------------------------------------------------------------
// Level meter.

fn clear_report(s: &mut State) {
    s.n = 0;
    s.sum = ZERO;
    s.peak = ZERO;
    s.fast_min = f32x4_splat(f32::INFINITY);
    s.fast_max = ZERO;
    s.slow_min = f32x4_splat(f32::INFINITY);
    s.slow_max = ZERO;
}

fn write_report(s: &mut State) {
    let r = &mut s.report;
    r[0] = s.n as f64;
    r[1] = s.n as f64 / s.sample_rate;
    let groups = [s.sum, s.peak, s.fast, s.slow, s.fast_min, s.fast_max, s.slow_min, s.slow_max];
    for (g, v) in groups.iter().enumerate() {
        r[2 + 3 * g] = f32x4_extract_lane::<0>(*v) as f64;
        r[3 + 3 * g] = f32x4_extract_lane::<1>(*v) as f64;
        r[4 + 3 * g] = f32x4_extract_lane::<2>(*v) as f64;
    }
}

fn level_block(s: &mut State, count: usize) -> bool {
    // Pass 1: the weighting filters, transposed direct form II. Two short
    // loops instead of one keep everything in registers.
    let c = s.coef;
    let (mut z1, mut z2) = (s.z1, s.z2);
    let [zb0, zb1, zb2, za1, za2] = s.coef_z;
    let [mut zs1, mut zs2] = s.zs;
    for i in 0..count {
        let x = s.input[i] as f64;
        let mut v = f64x2_splat(x);
        for k in 0..3 {
            let b = 5 * k;
            let out = f64x2_add(f64x2_mul(c[b], v), z1[k]);
            z1[k] = f64x2_add(f64x2_sub(f64x2_mul(c[b + 1], v), f64x2_mul(c[b + 3], out)), z2[k]);
            z2[k] = f64x2_sub(f64x2_mul(c[b + 2], v), f64x2_mul(c[b + 4], out));
            v = out;
        }
        let z = zb0 * x + zs1;
        zs1 = zb1 * x - za1 * z + zs2;
        zs2 = zb2 * x - za2 * z;
        let y = f32x4_replace_lane::<2>(f32x4_demote_f64x2_zero(v), z as f32);
        s.squares[i] = f32x4_mul(y, y);
    }
    (s.z1, s.z2, s.zs) = (z1, z2, [zs1, zs2]);

    // Pass 2: energy, peak, Fast and Slow, their extremes; all three
    // weightings per instruction.
    let af = f32x4_splat(s.alpha_fast);
    let as_ = f32x4_splat(s.alpha_slow);
    let (mut sum, mut peak, mut fast, mut slow) = (s.sum, s.peak, s.fast, s.slow);
    let (mut fmin, mut fmax, mut smin, mut smax) = (s.fast_min, s.fast_max, s.slow_min, s.slow_max);
    let mut ready = false;
    for i in 0..count {
        let sq = s.squares[i];
        sum = f32x4_add(sum, sq);
        peak = f32x4_pmax(peak, sq);
        fast = f32x4_add(fast, f32x4_mul(f32x4_sub(sq, fast), af));
        slow = f32x4_add(slow, f32x4_mul(f32x4_sub(sq, slow), as_));
        fmin = f32x4_pmin(fmin, fast);
        fmax = f32x4_pmax(fmax, fast);
        smin = f32x4_pmin(smin, slow);
        smax = f32x4_pmax(smax, slow);
        s.n += 1;
        if s.n == s.report_samples {
            (s.sum, s.peak, s.fast, s.slow) = (sum, peak, fast, slow);
            (s.fast_min, s.fast_max, s.slow_min, s.slow_max) = (fmin, fmax, smin, smax);
            write_report(s);
            clear_report(s);
            (sum, peak) = (s.sum, s.peak);
            (fmin, fmax, smin, smax) = (s.fast_min, s.fast_max, s.slow_min, s.slow_max);
            ready = true;
        }
    }
    // Start the time weighting at the level of the first block instead of
    // creeping up from silence.
    if !s.primed && s.n > 0 {
        fast = f32x4_div(sum, f32x4_splat(s.n as f32));
        slow = fast;
        s.primed = true;
    }
    (s.sum, s.peak, s.fast, s.slow) = (sum, peak, fast, slow);
    (s.fast_min, s.fast_max, s.slow_min, s.slow_max) = (fmin, fmax, smin, smax);
    ready
}

// ---------------------------------------------------------------------------
// Spectrum analyser.

fn spectrum_block(s: &mut State, count: usize) -> bool {
    let (n, hop) = (s.fft_n, s.hop);
    if hop == 0 {
        return false;
    }
    let mut ready = false;
    let mut off = 0;
    while off < count {
        let take = (count - off).min(hop - s.pos);
        let at = n - hop + s.pos;
        s.history[at..at + take].copy_from_slice(&s.input[off..off + take]);
        s.pos += take;
        s.warm += take;
        off += take;
        if s.pos == hop {
            // Only once the window is full: a half-empty one would drag the
            // averages down at the start.
            if s.warm >= n {
                analyse(s);
                ready = true;
            }
            s.history.copy_within(hop..n, 0);
            s.pos = 0;
        }
    }
    ready
}

fn analyse(s: &mut State) {
    unsafe { pack(s) };
    unsafe { fft(s) };
    unsafe { split_power(s) };
    average(s);
    select_average(s);
    pool_columns(s);
}

/// Windows the history and packs it for the half-size complex FFT: even
/// samples real, odd imaginary, then into bit-reversed order by swapping.
unsafe fn pack(s: &mut State) {
    let m = s.fft_m;
    let h = s.history.as_ptr();
    let w = s.window.as_ptr();
    let re = s.re.as_mut_ptr();
    let im = s.im.as_mut_ptr();
    unsafe {
        let mut i = 0;
        while i < m {
            let a = f32x4_mul(load(h.add(2 * i)), load(w.add(2 * i)));
            let b = f32x4_mul(load(h.add(2 * i + 4)), load(w.add(2 * i + 4)));
            store(re.add(i), i32x4_shuffle::<0, 2, 4, 6>(a, b));
            store(im.add(i), i32x4_shuffle::<1, 3, 5, 7>(a, b));
            i += 4;
        }
        let rev = s.bitrev.as_ptr();
        for i in 0..m {
            let j = *rev.add(i) as usize;
            if i < j {
                core::ptr::swap(re.add(i), re.add(j));
                core::ptr::swap(im.add(i), im.add(j));
            }
        }
    }
}

/// In-place FFT of size M on (re, im), input bit-reversed. The first two
/// stages are scalar, the rest radix 4 with four butterflies per instruction.
unsafe fn fft(s: &mut State) {
    let m = s.fft_m;
    let re = s.re.as_mut_ptr();
    let im = s.im.as_mut_ptr();
    unsafe {
        let mut i = 0;
        while i < m {
            // Stage h = 1 (twiddle 1) and h = 2 (twiddles 1, -i) merged.
            let (r0, i0) = (*re.add(i), *im.add(i));
            let (r1, i1) = (*re.add(i + 1), *im.add(i + 1));
            let (r2, i2) = (*re.add(i + 2), *im.add(i + 2));
            let (r3, i3) = (*re.add(i + 3), *im.add(i + 3));
            let (a0r, a0i, a1r, a1i) = (r0 + r1, i0 + i1, r0 - r1, i0 - i1);
            let (b0r, b0i, b1r, b1i) = (r2 + r3, i2 + i3, r2 - r3, i2 - i3);
            *re.add(i) = a0r + b0r;
            *im.add(i) = a0i + b0i;
            *re.add(i + 2) = a0r - b0r;
            *im.add(i + 2) = a0i - b0i;
            // b1 · (-i) = (b1i, -b1r)
            *re.add(i + 1) = a1r + b1i;
            *im.add(i + 1) = a1i - b1r;
            *re.add(i + 3) = a1r - b1i;
            *im.add(i + 3) = a1i + b1r;
            i += 4;
        }
        let twr = s.tw_re.as_ptr();
        let twi = s.tw_im.as_ptr();
        // Stages h and 2h at once (radix 4): half the passes over memory.
        let mut h = 4;
        while 4 * h <= m {
            let mut k = 0;
            while k < m {
                let mut j = 0;
                while j < h {
                    let (w1r, w1i) = (load(twr.add(h + j)), load(twi.add(h + j)));
                    let (w2r, w2i) = (load(twr.add(2 * h + j)), load(twi.add(2 * h + j)));
                    let p0 = k + j;
                    let (p1, p2, p3) = (p0 + h, p0 + 2 * h, p0 + 3 * h);
                    let (a0r, a0i) = (load(re.add(p0)), load(im.add(p0)));
                    let (a1r, a1i) = (load(re.add(p1)), load(im.add(p1)));
                    let (a2r, a2i) = (load(re.add(p2)), load(im.add(p2)));
                    let (a3r, a3i) = (load(re.add(p3)), load(im.add(p3)));
                    // Stage h: (p0, p1) and (p2, p3), both with w_h(j).
                    let (t1r, t1i) = cmul(a1r, a1i, w1r, w1i);
                    let (t3r, t3i) = cmul(a3r, a3i, w1r, w1i);
                    let (b0r, b0i) = (f32x4_add(a0r, t1r), f32x4_add(a0i, t1i));
                    let (b1r, b1i) = (f32x4_sub(a0r, t1r), f32x4_sub(a0i, t1i));
                    let (b2r, b2i) = (f32x4_add(a2r, t3r), f32x4_add(a2i, t3i));
                    let (b3r, b3i) = (f32x4_sub(a2r, t3r), f32x4_sub(a2i, t3i));
                    // Stage 2h: (p0, p2) with w_2h(j), (p1, p3) with w_2h(j + h) = -i·w_2h(j).
                    let (u2r, u2i) = cmul(b2r, b2i, w2r, w2i);
                    let (vr, vi) = cmul(b3r, b3i, w2r, w2i);
                    let (u3r, u3i) = (vi, f32x4_neg(vr));
                    store(re.add(p0), f32x4_add(b0r, u2r));
                    store(im.add(p0), f32x4_add(b0i, u2i));
                    store(re.add(p2), f32x4_sub(b0r, u2r));
                    store(im.add(p2), f32x4_sub(b0i, u2i));
                    store(re.add(p1), f32x4_add(b1r, u3r));
                    store(im.add(p1), f32x4_add(b1i, u3i));
                    store(re.add(p3), f32x4_sub(b1r, u3r));
                    store(im.add(p3), f32x4_sub(b1i, u3i));
                    j += 4;
                }
                k += 4 * h;
            }
            h *= 4;
        }
        // An odd number of stages leaves one radix-2 stage.
        while h < m {
            let mut k = 0;
            while k < m {
                let mut j = 0;
                while j < h {
                    let (wr, wi) = (load(twr.add(h + j)), load(twi.add(h + j)));
                    let (pa, pb) = (k + j, k + j + h);
                    let (ar, ai) = (load(re.add(pa)), load(im.add(pa)));
                    let (tr, ti) = cmul(load(re.add(pb)), load(im.add(pb)), wr, wi);
                    store(re.add(pa), f32x4_add(ar, tr));
                    store(im.add(pa), f32x4_add(ai, ti));
                    store(re.add(pb), f32x4_sub(ar, tr));
                    store(im.add(pb), f32x4_sub(ai, ti));
                    j += 4;
                }
                k += 2 * h;
            }
            h *= 2;
        }
    }
}

#[inline(always)]
fn cmul(ar: v128, ai: v128, br: v128, bi: v128) -> (v128, v128) {
    (
        f32x4_sub(f32x4_mul(ar, br), f32x4_mul(ai, bi)),
        f32x4_add(f32x4_mul(ar, bi), f32x4_mul(ai, br)),
    )
}

/// Turns the half-size complex FFT into the power spectrum of the real input:
/// X[k] = E + W^k·O with E, O the spectra of the even and odd samples.
unsafe fn split_power(s: &mut State) {
    let m = s.fft_m;
    let scale = s.scale;
    // Bins 0..3 scalar: their mirror index wraps around.
    for k in 0..4 {
        let mk = (m - k) % m;
        let (zr, zi, cr, ci) = (s.re[k], s.im[k], s.re[mk], -s.im[mk]);
        let (er, ei) = (0.5 * (zr + cr), 0.5 * (zi + ci));
        let (dr, di) = (0.5 * (zr - cr), 0.5 * (zi - ci));
        let (or, oi) = (di, -dr);
        let (wr, wi) = (s.pt_re[k], s.pt_im[k]);
        let xr = er + wr * or - wi * oi;
        let xi = ei + wr * oi + wi * or;
        s.power[k] = (xr * xr + xi * xi) * scale;
    }
    unsafe {
        let re = s.re.as_ptr();
        let im = s.im.as_ptr();
        let half = f32x4_splat(0.5);
        let sc = f32x4_splat(scale);
        let mut k = 4;
        while k < m {
            let zr = load(re.add(k));
            let zi = load(im.add(k));
            // Z[M-k-3 .. M-k] reversed, conjugated.
            let rr = load(re.add(m - k - 3));
            let ri = load(im.add(m - k - 3));
            let cr = i32x4_shuffle::<3, 2, 1, 0>(rr, rr);
            let ci = f32x4_neg(i32x4_shuffle::<3, 2, 1, 0>(ri, ri));
            let er = f32x4_mul(half, f32x4_add(zr, cr));
            let ei = f32x4_mul(half, f32x4_add(zi, ci));
            let or = f32x4_mul(half, f32x4_sub(zi, ci));
            let oi = f32x4_mul(half, f32x4_sub(cr, zr));
            let wr = load(s.pt_re.as_ptr().add(k));
            let wi = load(s.pt_im.as_ptr().add(k));
            let xr = f32x4_add(er, f32x4_sub(f32x4_mul(wr, or), f32x4_mul(wi, oi)));
            let xi = f32x4_add(ei, f32x4_add(f32x4_mul(wr, oi), f32x4_mul(wi, or)));
            let p = f32x4_mul(f32x4_add(f32x4_mul(xr, xr), f32x4_mul(xi, xi)), sc);
            store(s.power.as_mut_ptr().add(k), p);
            k += 4;
        }
    }
}

fn average(s: &mut State) {
    let m = s.fft_m;
    if !s.spectrum_primed {
        s.avg_short[..m].copy_from_slice(&s.power[..m]);
        s.avg_long[..m].copy_from_slice(&s.power[..m]);
        s.spectrum_primed = true;
    }
    unsafe {
        let p = s.power.as_ptr();
        let a1 = s.avg_short.as_mut_ptr();
        let a2 = s.avg_long.as_mut_ptr();
        let t = s.total.as_mut_ptr();
        let k1 = f32x4_splat(s.alpha_short);
        let k2 = f32x4_splat(s.alpha_long);
        let mut k = 0;
        while k < m {
            let v = load(p.add(k));
            let x1 = load(a1.add(k));
            store(a1.add(k), f32x4_add(x1, f32x4_mul(f32x4_sub(v, x1), k1)));
            let x2 = load(a2.add(k));
            store(a2.add(k), f32x4_add(x2, f32x4_mul(f32x4_sub(v, x2), k2)));
            let lo = f64x2_promote_low_f32x4(v);
            let hi = f64x2_promote_low_f32x4(i32x4_shuffle::<2, 3, 0, 1>(v, v));
            let tp = t.add(k) as *mut v128;
            v128_store(tp, f64x2_add(v128_load(tp), lo));
            v128_store(tp.add(1), f64x2_add(v128_load(tp.add(1)), hi));
            k += 4;
        }
    }
    s.frames += 1.0;
}

fn select_average(s: &mut State) {
    let m = s.fft_m;
    match s.mode {
        0 => s.selected[..m].copy_from_slice(&s.avg_short[..m]),
        1 => s.selected[..m].copy_from_slice(&s.avg_long[..m]),
        _ => unsafe {
            let inv = f64x2_splat(if s.frames > 0.0 { 1.0 / s.frames } else { 0.0 });
            let t = s.total.as_ptr() as *const v128;
            let d = s.selected.as_mut_ptr();
            let mut k = 0;
            while k < m {
                let lo = f32x4_demote_f64x2_zero(f64x2_mul(v128_load(t.add(k / 2)), inv));
                let hi = f32x4_demote_f64x2_zero(f64x2_mul(v128_load(t.add(k / 2 + 1)), inv));
                store(d.add(k), i32x4_shuffle::<0, 1, 4, 5>(lo, hi));
                k += 4;
            }
        },
    }
}

fn pool_columns(s: &mut State) {
    let m = s.fft_m;
    let cols = s.cols;
    unsafe {
        let p = s.power.as_ptr();
        let q = s.selected.as_ptr();
        let e = s.edges.as_ptr();
        let live = s.live_cols.as_mut_ptr();
        let avg = s.avg_cols.as_mut_ptr();
        for c in 0..cols {
            let (lo, hi) = (*e.add(2 * c), *e.add(2 * c + 1));
            let first = ceil_index(lo).min(m);
            let end = ceil_index(hi).min(m);
            if end > first {
                // Strongest bin in the column, four at a time.
                let mut k = first;
                let (mut va, mut vb) = (ZERO, ZERO);
                while k + 4 <= end {
                    va = f32x4_pmax(va, load(p.add(k)));
                    vb = f32x4_pmax(vb, load(q.add(k)));
                    k += 4;
                }
                let mut a = hmax(va);
                let mut b = hmax(vb);
                while k < end {
                    a = if *p.add(k) > a { *p.add(k) } else { a };
                    b = if *q.add(k) > b { *q.add(k) } else { b };
                    k += 1;
                }
                *live.add(c) = a;
                *avg.add(c) = b;
            } else {
                let centre = 0.5 * (lo + hi);
                let k = (centre as usize).min(m - 2);
                let f = centre - k as f32;
                *live.add(c) = *p.add(k) + (*p.add(k + 1) - *p.add(k)) * f;
                *avg.add(c) = *q.add(k) + (*q.add(k + 1) - *q.add(k)) * f;
            }
        }
        let mut c = 0;
        while c < cols {
            store(live.add(c), db4(load(live.add(c))));
            store(avg.add(c), db4(load(avg.add(c))));
            c += 4;
        }
    }
}

#[inline(always)]
fn hmax(v: v128) -> f32 {
    let v = f32x4_pmax(v, i32x4_shuffle::<2, 3, 0, 1>(v, v));
    let v = f32x4_pmax(v, i32x4_shuffle::<1, 0, 3, 2>(v, v));
    f32x4_extract_lane::<0>(v)
}

#[inline(always)]
fn ceil_index(x: f32) -> usize {
    if x <= 0.0 {
        return 0;
    }
    let i = x as usize;
    if (i as f32) < x { i + 1 } else { i }
}

