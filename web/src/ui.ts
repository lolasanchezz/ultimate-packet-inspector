// the panels around the map. each one is rendered whole from the model - there's
// little enough in them that diffing isn't worth it
import {ms, type Conn, type Machine, type Traffic} from './db';
import {esc, flag, fmtAgo, fmtBytes, fmtClock, fmtCount, fmtDuration, fmtMs, fmtPct, fmtTime, PROTOS, service} from './format';
import {colorOf, rgb, type Group, type Model, type Owner, type Packet} from './scene';
import {METRICS, binsFor, periodsFor, phraseOf, searchMetrics, windowOf, type Inspection, type Metric, type Proc} from './stats';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let machineOptions = ''; // what the machine picker was last given - only redrawn when that changes

export function renderHeader(model: Model, machines: Machine[], status: string) {
    const select = $<HTMLSelectElement>('machine');
    const opts = machines.map(m => `<option value="${m.id}"${m.id === model.machine?.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    if (opts !== machineOptions) select.innerHTML = machineOptions = opts;
    select.hidden = machines.length < 2;
    $('machine-name').textContent = machines.length < 2 ? (model.machine?.name ?? '') : '';

    const m = model.machine;
    const seen = m ? ms(m.lastSeenUs) : 0;
    const agentUp = m && Date.now() - seen < 30_000;
    const bits = [];
    if (status !== 'connected') bits.push(`<span class="keyed"><i class="dot off"></i>${esc(status)}</span>`);
    else if (m) {
        bits.push(agentUp ? `<span class="keyed"><i class="dot good"></i>agent up</span>` : `<span class="keyed"><i class="dot off"></i>agent last seen ${fmtAgo(seen)}</span>`);
        if (agentUp) bits.push(`<span>${Math.round(m.pps)} packets/s</span>`);
        if (m.sampled > 1) bits.push(`<span class="warn" title="above its packet budget the agent records 1 in ${m.sampled} packets - byte counts stay exact">sampling 1 in ${m.sampled}</span>`);
        if (!m.nstat) bits.push(`<span class="warn" title="NetworkStatistics isn't available, so processes are matched with socket scans - QUIC and root's traffic may show as unknown">socket scans</span>`);
        if (!m.geo) bits.push(`<span class="warn" title="run scripts/fetch-geo.sh on the machine">no geo databases</span>`);
    }
    $('status').innerHTML = bits.join('');
    $('forget').hidden = !model.machine;
}

// --- the overview ---

const procLabel = (p: Proc) => (p.pid > 0 ? `${esc(p.name)}<span class="dim">: pid ${p.pid}</span>` : esc(p.name));

// which page the column's showing
export function renderTabs(tab: 'overview' | 'inspector') {
    for (const b of document.querySelectorAll<HTMLElement>('[data-tab]')) {
        if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
    }
    $('overview-view').hidden = tab !== 'overview';
    $('inspector-view').hidden = tab !== 'inspector';
    $('column').classList.toggle('inspecting', tab === 'inspector');
}

// "sorted by: ... (how far back)" and the menu behind it. with nothing typed it's
// every stat, by group; typing narrows it to the ones that match - by name, keyword
// or what they're about - best first, each with its group. periodOf is the period
// each stat's on, for the ones that have one
export function renderSort(metric: Metric, query: string, periodOf: (m: Metric) => number | undefined) {
    $('sort-phrase').textContent = phraseOf(metric);
    $('sort-window').textContent = windowOf(metric, periodOf(metric));
    $<HTMLButtonElement>('period-open').disabled = metric.period === undefined;
    const note = (m: Metric) => windowOf(m, periodOf(m));
    $<HTMLInputElement>('sort-search').placeholder = `search ${METRICS.length} stats...`;
    const item = (m: Metric, note: string) =>
        `<button role="option" data-value="${m.id}" aria-selected="${m.id === metric.id}" title="${esc(m.about)}"><span>${esc(m.label)}</span><span class="note">${esc(note)}</span></button>`;
    let html: string;
    if (query.trim()) {
        const found = searchMetrics(query);
        html = found.length
            ? `<div class="count">${found.length} of ${METRICS.length}</div>${found.map(m => item(m, `${m.group.replace(' stats', '')} · ${note(m)}`)).join('')}`
            : '<div class="none">nothing called that</div>';
    } else {
        const groups = [...new Set(METRICS.map(m => m.group))];
        html = groups.map(g => `<div class="group">${esc(g)}</div>${METRICS.filter(m => m.group === g).map(m => item(m, note(m))).join('')}`).join('');
    }
    $('sort-items').innerHTML = html;
}

// how far back the sorted-by stat looks - the choices it can have, the current one marked
export function renderPeriods(current: number, metric: Metric) {
    $('period-menu').innerHTML = periodsFor(metric).map(p => `<button role="option" data-value="${p.minutes}" aria-selected="${p.minutes === current}">${p.label}</button>`).join('');
}

// --- the chart: the top processes' stat over time ---

const CHART_SERIES = 8;
let chart: {procs: Proc[]; metric: Metric; period: number} | undefined;
let chartAt: number | undefined; // the bar under the pointer, or picked with the arrow keys
let plot = {w: 300, left: 0, right: 0, n: 15}; // where the bars are, for finding the one under the pointer

// round steps from 0 to just past the peak - 0 / 20 / 40, 0 / 2.5 / 5
function ticks(peak: number, whole: boolean): number[] {
    if (!(peak > 0)) return [0, whole ? 1 : peak || 1];
    const rough = peak / 3;
    const mag = 10 ** Math.floor(Math.log10(rough));
    let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= rough)!;
    if (whole) step = Math.max(1, Math.round(step));
    return Array.from({length: Math.ceil(peak / step - 1e-9) + 1}, (_, i) => i * step);
}

// how long before now a bar is, in words: -20s, -45m, -6h
const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${+(ms / 3_600_000).toFixed(1)}h`);

// the top processes, a line each, on white axes as in the design - with the
// stat's values up the side, the time along the bottom, and a dot where each
// line is now. hovering (or the arrow keys) shows every value at that bar
export function renderChart(procs: Proc[], metric: Metric, period = metric.period ?? 1) {
    chart = {procs: procs.filter(p => p.value !== undefined).slice(0, CHART_SERIES), metric, period};
    drawChart();
}

function drawChart() {
    if (!chart) return;
    const {procs, metric, period} = chart;
    const {n, binMs} = binsFor(period);
    const msAgo = (i: number) => (n - 1 - i) * binMs;
    const w = Math.max(200, Math.round($('chart').clientWidth || 300));
    const h = Math.round(w * 0.5);

    const values = procs.flatMap(p => p.series.filter((v): v is number => v !== undefined));
    const ys = ticks(Math.max(0, ...values), metric.format === fmtCount);
    const top = ys[ys.length - 1];
    const labels = ys.map(v => metric.format(v));
    // room for the longest label on the left, the time underneath
    const left = 10 + 6.6 * Math.max(...labels.map(l => l.length)), right = 6, above = 6, below = 18;
    plot = {w, left, right, n};
    const x = (i: number) => left + (i / Math.max(1, n - 1)) * (w - left - right);
    const y = (v: number) => above + (1 - v / top) * (h - above - below);

    const grid = ys
        .map((v, i) => `${i ? `<line class="grid" x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}"/>` : ''}<text class="tick" x="${left - 7}" y="${y(v) + 3.5}" text-anchor="end">${esc(labels[i])}</text>`)
        .join('');
    // the start, a third and two thirds along, and now
    const xs = [...new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1])]
        .map(i => `<text class="tick" x="${x(i)}" y="${h - 4}" text-anchor="${i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${i === n - 1 ? 'now' : `-${ago(msAgo(i))}`}</text>`)
        .join('');

    // the top one drawn last, on top. a bar with no way to know is a gap
    const lines = procs
        .slice()
        .reverse()
        .map(p => {
            const runs: string[][] = [[]];
            p.series.forEach((v, i) => {
                if (v === undefined) runs.push([]);
                else runs[runs.length - 1].push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
            });
            const color = rgb(colorOf(p.pid));
            const last = p.series[n - 1];
            return (
                runs
                    .filter(r => r.length)
                    .map(r => `<polyline points="${r.length === 1 ? `${r[0]} ${r[0]}` : r.join(' ')}" stroke="${color}"/>`)
                    .join('') + (last === undefined ? '' : `<circle class="dot" cx="${x(n - 1)}" cy="${y(last)}" r="3.5" fill="${color}"/>`)
            );
        })
        .join('');

    // the bar being looked at: a hairline, and a dot on every line there
    let cross = '';
    const at = chartAt === undefined ? undefined : Math.min(n - 1, Math.max(0, chartAt));
    if (at !== undefined && procs.length) {
        cross =
            `<line class="cross" x1="${x(at)}" x2="${x(at)}" y1="${above}" y2="${h - below}"/>` +
            procs
                .flatMap(p => (p.series[at] === undefined ? [] : [`<circle class="dot" cx="${x(at)}" cy="${y(p.series[at]!)}" r="3.5" fill="${rgb(colorOf(p.pid))}"/>`]))
                .join('');
    }

    const empty = procs.length ? '' : `<text class="tick" x="${(left + w) / 2}" y="${h / 2}" text-anchor="middle">nothing to show for this yet</text>`;
    $('chart-plot').innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(phraseOf(metric))} for the top processes over the last ${ago(n * binMs)}">
        ${grid}${xs}${lines}${cross}${empty}
        <path class="axis" d="M${left} ${above} V${h - below} H${w - right}"/>
    </svg>`;
    $('chart').setAttribute('aria-label', `chart of ${phraseOf(metric)} - arrow keys move through the bars`);

    // the readout, out to the right - every line's value at that bar, biggest first
    const tip = $('chart-tip');
    tip.hidden = at === undefined || !procs.length;
    if (tip.hidden || at === undefined) return;
    const before = msAgo(at);
    const rows = procs
        .flatMap(p => (p.series[at] === undefined ? [] : [{p, v: p.series[at]!}]))
        .sort((a, b) => b.v - a.v)
        .map(({p, v}) => `<div class="row"><i class="key" style="background:${rgb(colorOf(p.pid))}"></i><b>${esc(metric.format(v))}</b><span class="who">${esc(p.name)}</span></div>`)
        .join('');
    const bar = binMs > 60_000 ? `the ${binMs / 60_000} min to ` : '';
    tip.innerHTML = `<div class="when">${before ? `${bar}${ago(before)} ago` : `now - ${esc(windowOf(metric, period))}`}</div>${rows || '<div class="who">nothing then</div>'}`;
    // level with the top, just outside the chart so it never covers the lines
    tip.style.top = `${Math.max(0, Math.min(h - tip.offsetHeight, above))}px`;
}

// the pointer and the arrow keys pick a bar on the chart
export function initChart() {
    const el = $('chart');
    const at = (clientX: number) => {
        const r = el.querySelector('svg')?.getBoundingClientRect();
        if (!r) return undefined;
        const scale = r.width / plot.w;
        const f = (clientX - r.left - plot.left * scale) / ((plot.w - plot.left - plot.right) * scale);
        return Math.round(Math.min(1, Math.max(0, f)) * (plot.n - 1));
    };
    el.addEventListener('pointermove', e => {
        const i = at(e.clientX);
        if (i !== chartAt) {
            chartAt = i;
            drawChart();
        }
    });
    el.addEventListener('pointerleave', () => {
        chartAt = undefined;
        drawChart();
    });
    el.addEventListener('focus', () => {
        chartAt ??= plot.n - 1;
        drawChart();
    });
    el.addEventListener('blur', () => {
        chartAt = undefined;
        drawChart();
    });
    el.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        chartAt = Math.min(plot.n - 1, Math.max(0, (chartAt ?? plot.n - 1) + (e.key === 'ArrowLeft' ? -1 : 1)));
        drawChart();
    });
    // the chart's drawn at its real size, so it's redrawn when that changes
    new ResizeObserver(() => drawChart()).observe(el);
}

const CONNS_SHOWN = 6;

// every process, ranked. open ones show their connections on their colour
export function renderProcList(procs: Proc[], metric: Metric, open: Set<string>, pins: string[], groups: Map<string, Group>, period = metric.period) {
    $('procs').innerHTML = procs
        .map((p, i) => {
            const pinned = pins.includes(p.key);
            const isOpen = open.has(p.key);
            const pin = `<button class="pin" data-pin aria-pressed="${pinned}" title="${pinned ? 'unpin' : 'keep it at the top'}">pin</button>`;
            const name = procLabel(p);
            const value = p.value === undefined ? '–' : metric.format(p.value);
            const conns = p.conns
                .slice(0, CONNS_SHOWN)
                .map(c => {
                    const key = `${c.machineId}/${c.remoteIp}`;
                    const host = groups.get(key)?.endpoint.host || c.host || c.remoteIp;
                    const local = c.localPort ? `:${c.localPort} ` : '';
                    return `<li data-endpoint="${esc(key)}" title="${esc(c.remoteIp)}">
                        <div class="conn-line"><span class="dim">&gt; ${local}${service(c.proto, c.remotePort)} ${c.bytesUp >= c.bytesDown ? '→' : '←'}</span> ${esc(host)} <span class="dim">:${c.remotePort}</span></div>
                        <div class="conn-bytes"><span class="dim">&gt;&gt;</span> ${fmtBytes(c.bytesUp)} <span class="dim">↑</span> ${fmtBytes(c.bytesDown)} <span class="dim">↓</span></div>
                    </li>`;
                })
                .join('');
            const more = p.conns.length > CONNS_SHOWN ? `<div class="more">+ ${p.conns.length - CONNS_SHOWN} more</div>` : '';
            return `<li class="proc${isOpen ? ' open' : ''}" data-key="${esc(p.key)}" style="--c: ${rgb(colorOf(p.pid))}">
                <div class="proc-head">
                    <button class="proc-name" data-toggle aria-expanded="${isOpen}"><span class="rank">${i + 1}</span><span class="label">${name}</span><span class="chev">${isOpen ? '⌄' : '&gt;'}</span></button>
                    <span class="value" title="${esc(metric.about)} (${windowOf(metric, period)})">${value}</span>
                    <button class="inspect" data-inspect title="open it in the inspector">inspect</button>
                    ${isOpen ? '' : pin}
                </div>
                ${isOpen ? `<div class="proc-card">${pin}<ul class="proc-conns">${conns}</ul>${more}</div>` : ''}
            </li>`;
        })
        .join('');
}

export function renderOwners(owners: Owner[]) {
    const trackers = owners.filter(o => o.tracker);
    const countries = new Set(owners.flatMap(o => [...o.countries]));
    $('owners-sub').textContent = owners.length
        ? `${owners.length} ${owners.length === 1 ? 'company' : 'companies'} in ${countries.size} ${countries.size === 1 ? 'country' : 'countries'}` +
          (trackers.length ? ` · ${trackers.length} tracking` : '')
        : 'nothing yet';
    $('owners').innerHTML = owners
        .slice(0, 40)
        .map(
            o => `<li data-owner="${esc(o.name)}" class="${o.tracker ? 'tracker' : ''}" tabindex="0">
                <div class="row"><span class="name">${esc(o.name)}</span>${o.tracker ? '<span class="badge">tracker</span>' : ''}<span class="spacer"></span><span class="num">${fmtBytes(o.bytes)}</span></div>
                ${o.categories.size ? `<div class="chips">${[...o.categories].map(c => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
                <div class="meta">${esc([...o.processes].slice(0, 4).join(', '))}${o.processes.size > 4 ? ` +${o.processes.size - 4}` : ''} ${[...o.countries].map(flag).join(' ')}</div>
            </li>`,
        )
        .join('');
}

export function renderNearby(groups: Group[]) {
    $('nearby-count').textContent = String(groups.length);
    $('nearby').innerHTML = groups
        .slice(0, 50)
        .map(g => {
            const ep = g.endpoint;
            return `<li data-key="${esc(g.key)}" tabindex="0"><div class="row"><span class="name">${esc(ep.host || ep.ip)}</span><span class="spacer"></span><span class="num">${fmtBytes(g.bytes)}</span></div>
                <div class="meta">${esc(ep.kind)} · ${esc(g.processes.map(p => p || 'system').join(', '))}</div></li>`;
        })
        .join('');
}

export function renderDetail(g: Group | undefined, routeOpen: boolean) {
    const el = $('detail');
    el.hidden = !g;
    if (!g) return;
    const ep = g.endpoint;
    const place = [ep.city, ep.region, ep.country].filter(Boolean).join(', ');
    const rows = g.conns
        .slice()
        .sort((a, b) => b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown))
        .map(
            c => `<tr>
                <td><i class="swatch" style="background:${g.line ? rgb(g.line.color) : 'var(--text-muted)'}"></i>${esc(c.system ? 'system' : c.process || 'unknown')}${c.pid > 0 ? ` <span class="muted">${c.pid}</span>` : ''}</td>
                <td>${PROTOS[c.proto] ?? c.proto}/${c.remotePort}</td>
                <td class="num">↑${fmtBytes(c.bytesUp)} ↓${fmtBytes(c.bytesDown)}</td>
                <td>${c.open ? 'open' : `<span class="muted">${fmtAgo(ms(c.lastUs))}</span>`}${c.plaintext ? ' <span class="badge warn" title="readable text went over this connection - it isn\'t encrypted">unencrypted</span>' : ''}</td>
            </tr>`,
        )
        .join('');

    el.innerHTML = `
        <div class="card-head"><h2>${esc(ep.host || ep.ip)}</h2><span class="spacer"></span><button class="ghost" id="detail-close" aria-label="close">×</button></div>
        <dl>
            ${ep.owner || ep.org ? `<dt>owner</dt><dd>${esc(ep.owner || ep.org)}${ep.tracker ? ' <span class="badge">tracker</span>' : ''}${ep.categories.length ? `<div class="chips">${ep.categories.map(c => `<span>${esc(c)}</span>`).join('')}</div>` : ''}</dd>` : ''}
            <dt>address</dt><dd>${esc(ep.ip)}${ep.ptr && ep.ptr !== ep.host ? `<div class="muted">${esc(ep.ptr)}</div>` : ''}</dd>
            ${ep.asn ? `<dt>network</dt><dd>AS${ep.asn} ${esc(ep.org)}</dd>` : ''}
            ${place && ep.possible ? `<dt>location</dt><dd>${flag(ep.countryCode)} ${esc(place)}</dd>` : ''}
            ${ep.rttMs > 0 ? `<dt>round trip</dt><dd>${fmtMs(ep.rttMs)}</dd>` : ''}
        </dl>
        <table class="conns"><tbody>${rows}</tbody></table>
        ${route(g, routeOpen)}`;
}

// the traceroute, folded away until it's asked for - opening it shows the routers on the map too
function route(g: Group, open: boolean): string {
    if (!g.route) return `<p class="muted">no route traced yet - the line's a straight great circle until one comes in</p>`;
    const cables = g.drawn?.cables ?? [];
    const hops = g.hops
        .map(
            h => `<li class="${h.ip ? '' : 'muted'}">
                <span class="ttl">${esc(String(h.ttl))}</span>
                <span class="hop">${h.ip ? esc(h.ptr || h.ip) : '* no answer'}${h.city && h.located && h.possible ? `<span class="muted"> ${flag(h.country)} ${esc(h.city)}${h.from && h.from !== 'geoip' ? ` (from "${esc(h.from)}" in its name)` : ''}</span>` : ''}</span>
                <span class="num">${h.ip ? fmtMs(Number(h.rttMs) || 0) : ''}</span>
            </li>`,
        )
        .join('');
    const answered = g.hops.filter(h => h.ip).length;
    return `<details class="route" id="route"${open ? ' open' : ''}>
        <summary>route <span class="muted">${answered} ${answered === 1 ? 'hop' : 'hops'}${cables.length ? ` · ${cables.length} undersea ${cables.length === 1 ? 'cable' : 'cables'}` : ''} · traced ${fmtAgo(ms(g.route.tracedUs))}</span></summary>
        ${cables.length ? `<p class="cables">under the sea on ${cables.map(c => `<b>${esc(c)}</b>`).join(', ')}</p>` : ''}
        <ol class="hops">${hops}</ol>
    </details>`;
}

// per-minute traffic for the last day, in five-minute bars. the shaded part is
// what the map's showing
export function renderTimeline(traffic: Traffic[], window: {fromMs: number; toMs: number} | null, nowMs: number) {
    const binMs = 5 * 60_000;
    const end = Math.ceil(nowMs / binMs) * binMs, start = end - 24 * 3600_000;
    const bins = new Array<number>((end - start) / binMs).fill(0);
    for (const t of traffic) {
        const i = Math.floor((ms(t.minuteUs) - start) / binMs);
        if (i >= 0 && i < bins.length) bins[i] += t.bytesUp + t.bytesDown;
    }
    const peak = Math.max(1, ...bins);
    const w = 1000, h = 48, bw = w / bins.length;
    const bars = bins
        .map((b, i) => (b ? `<rect x="${(i * bw).toFixed(2)}" y="${(h - (h - 2) * Math.sqrt(b / peak)).toFixed(2)}" width="${Math.max(1, bw - 0.6).toFixed(2)}" height="${((h - 2) * Math.sqrt(b / peak)).toFixed(2)}"/>` : ''))
        .join('');
    const x = (t: number) => ((t - start) / (end - start)) * w;
    const shade = window ? `<rect class="window" x="${x(window.fromMs)}" y="0" width="${Math.max(2, x(window.toMs) - x(window.fromMs))}" height="${h}"/>` : '';
    const ticks = [0, 6, 12, 18, 24].map(hr => {
        const t = start + hr * 3600_000;
        return `<text x="${x(t)}" y="${h + 12}" text-anchor="${hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'}">${hr === 24 ? 'now' : fmtClock(t)}</text>`;
    });
    $('timeline-svg').innerHTML = `<svg viewBox="0 -2 ${w} ${h + 16}" preserveAspectRatio="none" role="img" aria-label="traffic over the last 24 hours - click to replay a moment">${shade}<g class="bars">${bars}</g>${ticks.join('')}</svg>`;
    return {start, end};
}

// --- the inspector: one process close up ---

// the processes to pick from, narrowed to what's been typed
export function renderPicker(procs: Proc[], current: string | undefined, query: string) {
    const q = query.trim().toLowerCase();
    const items = procs.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
    $('inspect-items').innerHTML = items.length
        ? items
              .slice(0, 100)
              .map(p => `<button role="option" data-value="${esc(p.key)}" aria-selected="${p.key === current}">${procLabel(p)}</button>`)
              .join('')
        : '<div class="none">nothing called that</div>';
}

const PACKETS_SHOWN = 60;

export function renderInspector(p: Proc | undefined, insp: Inspection | undefined, packets: Packet[], groups: Map<string, Group>) {
    $('inspect-name').innerHTML = p ? `<i class="swatch" style="background:${rgb(colorOf(p.pid))}"></i>${esc(p.name)}` : 'nothing yet';
    if (!p || !insp) {
        $('inspector').innerHTML = '<p class="empty">waiting for traffic...</p>';
        return;
    }
    const host = (c: Conn) => groups.get(`${c.machineId}/${c.remoteIp}`)?.endpoint.host || c.host;
    const about = [p.pid > 0 ? `pid ${p.pid}` : "traffic no process owns", insp.aliveMs === undefined ? '' : `running ${fmtDuration(insp.aliveMs)}`].filter(Boolean).join(' · ');
    const stat = (label: string, value: string, small = '') =>
        `<div><div class="label">${label}</div><div class="big">${value}</div>${small ? `<div class="small">${small}</div>` : ''}</div>`;
    const maybe = (n: number | undefined, f: (n: number) => string) => (n === undefined ? '–' : f(n));

    // what it's connected to right now, named ones first
    const hosts = new Map<string, string>();
    for (const c of p.conns) if (c.open) hosts.set(`${c.machineId}/${c.remoteIp}`, host(c) || c.remoteIp);
    const chips = [...hosts]
        .sort(([, a], [, b]) => Number(/^[\d.:]+$/.test(a)) - Number(/^[\d.:]+$/.test(b)) || a.localeCompare(b))
        .map(([key, name]) => `<button data-endpoint="${esc(key)}" title="show it on the map">${esc(name)}</button>`)
        .join('');

    const rows = packets
        .slice(0, PACKETS_SHOWN)
        .map(pk => {
            const c = pk.conn;
            const name = host(c);
            return `<tr data-endpoint="${esc(`${c.machineId}/${c.remoteIp}`)}">
                <td>${fmtTime(pk.timeUs / 1000)}</td>
                <td><span class="dir${pk.out ? ' sent' : ''}">${pk.out ? 'sent' : 'received'}</span></td>
                <td class="remote" title="${esc(c.remoteIp)}">${esc(name || c.remoteIp)}:${c.remotePort}${name ? `<span class="ip">${esc(c.remoteIp)}</span>` : ''}</td>
                <td>${c.localPort || ''}</td>
                <td>${service(c.proto, c.remotePort)}</td>
                <td class="right">${fmtBytes(pk.size)}</td>
            </tr>`;
        })
        .join('');

    // the packets scroll on their own - and stay where they were through the redraw
    const scrolled = $('inspector').querySelector('.packets')?.scrollTop ?? 0;
    $('inspector').innerHTML = `
        <div class="about">${about}</div>
        <div class="istats">
            ${stat('received, last minute', fmtBytes(insp.down))}
            ${stat('sent, last minute', fmtBytes(insp.up))}
            ${stat('packets sent, last minute', fmtCount(insp.packetsSent))}
            ${stat('total packets', fmtCount(insp.totalSent + insp.totalReceived), `${fmtCount(insp.totalSent)} sent · ${fmtCount(insp.totalReceived)} received`)}
            ${stat('open connections', String(insp.open))}
            ${stat('median latency', maybe(insp.medianMs, fmtMs))}
            ${stat('cpu usage', maybe(insp.cpu, fmtPct))}
            ${stat('memory', maybe(insp.memory, fmtBytes))}
        </div>
        <div class="connected"><span class="label">connected to</span>${chips || '<span class="label">nothing right now</span>'}</div>
        <div class="packets-head"><span>recent packets</span><span class="sub">newest first</span></div>
        <div class="packets">${
            rows
                ? `<table><thead><tr><th>time</th><th>direction</th><th>remote</th><th>local port</th><th>protocol</th><th class="right">size</th></tr></thead><tbody>${rows}</tbody></table>`
                : '<p class="empty">no packets in the last 30 seconds</p>'
        }</div>`;
    const list = $('inspector').querySelector('.packets');
    if (list) list.scrollTop = scrolled;
}
