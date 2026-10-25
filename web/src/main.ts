// ultimate packet inspector - the website. pairs with a machine running the agent,
// then draws everything it talks to, live - an overview of every process, or
// one close up in the inspector
import {feature} from 'topojson-client';
import type {Topology} from 'topojson-specification';
import landTopo from 'world-atlas/land-110m.json';
import {Db, type Conn} from './db';
import {DemoSource} from './demo';
import {Land, type Cable} from './geo';
import {WorldMap} from './map';
import {Router, landRings} from './paths';
import {buildModel, forgetChunks, recentPackets, trips, type Model} from './scene';
import {DEFAULT_METRIC, binsFor, inspect, metricById, overview, periodsFor, placesOf, procKey, type Metric, type Proc} from './stats';
import {initChart, renderChart, renderDetail, renderHeader, renderInspector, renderPeriods, renderPicker, renderProcList, renderSort, renderTabs} from './ui';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-500.css';
import './colors.css';
import './style.css';

const MINUTE = 60_000;
// connections drawn on the map: anything active this recently. the stats can look
// further back - as far as the period they're on
const LIVE_WINDOW = 15 * MINUTE;
// packets are shown this far behind real time, so the agent's batches (every 2s)
// have arrived before their packets are due on screen
const LIVE_DELAY = 5000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// this browser's own preferences - the sort, the pins. private windows and
// blocked storage just don't remember them
function load(k: string): string | undefined {
    try {
        return localStorage.getItem(k) ?? undefined;
    } catch {
        return undefined;
    }
}
function save(k: string, v: string) {
    try {
        localStorage.setItem(k, v);
    } catch {
        // see load
    }
}

// where the database is: what the build was given (the repo's .env), unless a
// link says otherwise - `upi pair` links carry #db=...&server=... so a site built
// without them still works, and it remembers them for next time
function settings() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const server = hash.get('server') ?? (import.meta.env.UPI_DB ? import.meta.env.UPI_SERVER : load('upi.server') ?? import.meta.env.UPI_SERVER);
    const db = hash.get('db') ?? (import.meta.env.UPI_DB || load('upi.db') || '');
    if (hash.has('db')) save('upi.db', db);
    if (hash.has('server')) save('upi.server', server);
    return {server, db, pair: hash.get('pair') ?? undefined, demo: hash.has('demo')};
}

// the land outline isn't drawn any more (the ascii basemap is), but it's still how
// routes tell an ocean crossing from a long way overland
const topoLand = landTopo as unknown as Topology;
const land = new Land(landRings(feature(topoLand, topoLand.objects.land)));

async function main() {
    const {server, db: database, pair, demo} = settings();
    if (!database && !demo) {
        showPairing("This site was built without a database. Set UPI_DB in the repo's .env and rebuild, or open the link `upi pair` prints.");
        return;
    }
    const cables: Cable[] = (await (await fetch(`${import.meta.env.BASE_URL}data/cables.json`)).json()).cables;
    const router = new Router(land, cables);
    const map = new WorldMap($<HTMLDivElement>('map'), cables, key => select(key), key => hover(key));
    map.loadAscii(`${import.meta.env.BASE_URL}data/`).catch(showError);
    const db = demo ? new DemoSource(`${import.meta.env.BASE_URL}demo/batches.jsonl`) : new Db(server, database);

    // what the viewer's picked
    let tab: 'overview' | 'inspector' = 'overview';
    let inspecting: string | undefined; // the process the inspector's on
    let selected: string | undefined; // an endpoint, clicked on the map or in a process
    let hovered: string | undefined; // the line under the mouse
    let hoveredProc: string | undefined; // the process under the mouse - its lines light up
    let routeOpen = false; // the endpoint card's route dropdown - its routers show on the map while it's open
    let metric = metricById(load('upi.sort') ?? DEFAULT_METRIC);
    // the period each stat's been set to, by id - the rest are on their own default
    let periods: Record<string, number> = {};
    try {
        periods = JSON.parse(load('upi.periods') ?? '{}');
    } catch {
        // garbled - start again
    }
    const periodOf = (m: Metric) => {
        if (m.period === undefined) return undefined;
        const set = periods[m.id];
        return periodsFor(m).some(p => p.minutes === set) ? set : m.period;
    };
    // what has to be loaded: the map's last LIVE_WINDOW, or the sorted-by stat's period
    // if that's longer - and its chart's first bar, which starts before it
    const reach = () => {
        const period = periodOf(metric) ?? 0;
        return Math.max(LIVE_WINDOW, period * MINUTE + binsFor(period).binMs);
    };
    let watching = 0; // the reach the last watch asked for
    let pins: string[] = (load('upi.pins') ?? '').split(',').filter(Boolean);
    const open = new Set<string>(pins); // pinned ones start open
    let model: Model | undefined;
    let procs: Proc[] = [];
    const baseMs = Date.now(); // packet times are seconds after this, for the gpu's float32s

    // --- the two menus: what to sort by, and which process to inspect ---

    const sortMenu = dropdown(
        'sort',
        q => renderSort(metric, q, periodOf),
        id => {
            metric = metricById(id);
            save('upi.sort', metric.id);
            rewatch();
            refresh();
        },
    );
    const pickMenu = dropdown(
        'inspect',
        q => renderPicker(procs, inspecting, q),
        key => show('inspector', key),
    );

    function watchLive(machineId: number) {
        const now = Date.now();
        watching = reach();
        db.setWatch(machineId, now - watching, 0, now - 24 * 60 * MINUTE).catch(showError);
    }

    // a stat or period that needs more (or less) history than is loaded
    function rewatch() {
        const m = model?.machine;
        if (m && reach() !== watching) watchLive(m.id);
    }

    function select(key: string | undefined) {
        selected = key === selected ? undefined : key;
        refresh();
    }

    function hover(key: string | undefined) {
        if (key === hovered) return;
        hovered = key;
        refresh();
    }

    function show(t: typeof tab, process?: string) {
        tab = t;
        if (process) inspecting = process;
        hoveredProc = undefined;
        refresh();
    }

    let pending = false;
    db.onChange(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            refresh();
        });
    });

    function refresh() {
        const status = db.status.state === 'error' ? `error: ${db.status.message}` : db.status.state;
        if (!db.ready) {
            $('status').textContent = status;
            return;
        }
        const machines = db.machines();
        if (!machines.length) {
            showPairing();
            return;
        }
        hidePairing();
        const watch = db.watch();
        const machine = machines.find(m => m.id === watch?.machineId);
        // not watching anything yet, or a replay left over from before - the overview's live
        if (!machine || watch!.toUs !== 0n) {
            watchLive(machine?.id ?? machines[0].id);
            return;
        }

        const nowMs = Date.now();
        const conns = db.conns();
        const groupKeys = (cs: Conn[]) => new Set(cs.map(c => `${c.machineId}/${c.remoteIp}`));
        const hoveredConns = hoveredProc === undefined ? [] : conns.filter(c => procKey(c) === hoveredProc);
        // the inspector only draws its own process's lines - the busiest one until something's picked
        const inspected = tab === 'inspector' ? (inspecting ?? procs[0]?.key) : undefined;
        const only = inspected === undefined ? undefined : groupKeys(conns.filter(c => procKey(c) === inspected));
        model = buildModel(machine, conns, db.endpoints(), db.routes(), router, {
            nowMs, selected, hovered, only, showRoute: routeOpen, highlighted: hoveredConns.length ? groupKeys(hoveredConns) : undefined,
            drawSince: nowMs - LIVE_WINDOW,
        });
        // a selection that's gone out of the window is let go
        if (selected && !model.groups.has(selected)) selected = undefined;
        // "San Francisco, US" - the country's what's after the last comma
        const homeCountry = /, ([A-Z]{2})$/.exec(machine.homePlace)?.[1] ?? '';
        const places = placesOf(model.groups.values(), model.home, homeCountry);
        const chunks = db.chunks();
        const period = periodOf(metric);
        procs = overview(conns, db.rollups(), db.procUsage(), db.procs(), places, metric, pins, nowMs, chunks, period);
        forgetChunks(chunks);
        const scene = {...model.scene, trips: trips(model, chunks, baseMs, 1)};
        map.setScene(scene);
        if (import.meta.env.DEV) Object.assign(window, {upi: {model, procs, scene, baseMs, chunks, map}});

        renderHeader(model, machines, status);
        renderTabs(tab);
        if (tab === 'overview') {
            renderSort(metric, sortMenu.query, periodOf);
            sortMenu.mark();
            renderChart(procs, metric, period);
            renderProcList(procs, metric, open, pins, model.groups, period);
        } else {
            const p = procs.find(p => p.key === inspected);
            renderPicker(procs, p?.key, pickMenu.query);
            pickMenu.mark();
            renderInspector(p, p && inspect(p, db.rollups(), db.procUsage(), db.procs(), places, nowMs), p ? recentPackets(p.conns, chunks, 60) : [], model.groups);
        }
        renderDetail(selected ? model.groups.get(selected) : undefined, routeOpen);
    }

    // the packets' clock: real time, a little behind
    function frame() {
        map.setTime((Date.now() - LIVE_DELAY - baseMs) / 1000);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // keep the live window sliding along
    setInterval(() => {
        const m = model?.machine;
        if (m) watchLive(m.id);
    }, MINUTE);
    // and "agent last seen" + the last minute fresh when nothing's arriving
    setInterval(refresh, 10_000);

    initChart();

    // --- the tabs, and the processes ---

    // how far back the sorted-by stat looks
    const periodMenu = $('period-menu');
    function showPeriods(on: boolean) {
        periodMenu.hidden = !on;
        $('period-open').setAttribute('aria-expanded', String(on));
        if (!on) return;
        renderPeriods(periodOf(metric) ?? 1, metric);
        periodMenu.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
    $('period-open').addEventListener('click', () => showPeriods(periodMenu.hidden));
    periodMenu.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]');
        if (!b) return;
        periods = {...periods, [metric.id]: Number(b.dataset.value)};
        save('upi.periods', JSON.stringify(periods));
        showPeriods(false);
        rewatch();
        refresh();
    });
    document.addEventListener('mousedown', e => {
        if (!periodMenu.hidden && !(e.target as HTMLElement).closest('.period')) showPeriods(false);
    });
    // the > opens the stat menu too
    $('sort-chev').addEventListener('click', () => $('sort-open').click());

    document.querySelector('.tabs')!.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
        if (b) show(b.dataset.tab as typeof tab);
    });
    $('procs').addEventListener('click', e => {
        const t = e.target as HTMLElement;
        const key = t.closest<HTMLElement>('.proc')?.dataset.key;
        if (!key) return;
        if (t.closest('[data-inspect]')) return show('inspector', key);
        if (t.closest('[data-pin]')) {
            if (pins.includes(key)) pins = pins.filter(k => k !== key);
            else {
                pins = [...pins, key];
                open.add(key);
            }
            save('upi.pins', pins.join(','));
        } else if (t.closest('[data-toggle]')) {
            if (!open.delete(key)) open.add(key);
        } else {
            const li = t.closest<HTMLElement>('[data-endpoint]');
            if (li) return select(li.dataset.endpoint);
        }
        refresh();
    });
    $('procs').addEventListener('mouseover', e => {
        const key = (e.target as HTMLElement).closest<HTMLElement>('.proc')?.dataset.key;
        if (key !== hoveredProc) {
            hoveredProc = key;
            refresh();
        }
    });
    $('procs').addEventListener('mouseleave', () => {
        hoveredProc = undefined;
        refresh();
    });
    // a host it's connected to, or a packet: that endpoint on the map
    $('inspector').addEventListener('click', e => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-endpoint]');
        if (el) select(el.dataset.endpoint);
    });

    // --- everything else ---

    $<HTMLSelectElement>('machine').addEventListener('change', e => {
        selected = undefined;
        watchLive(Number((e.target as HTMLSelectElement).value));
    });
    $('detail').addEventListener('click', e => {
        if ((e.target as HTMLElement).id === 'detail-close') select(undefined);
    });
    // toggle doesn't bubble - caught on the way down instead
    $('detail').addEventListener(
        'toggle',
        e => {
            const d = e.target as HTMLDetailsElement;
            if (d.id !== 'route' || d.open === routeOpen) return;
            routeOpen = d.open;
            refresh();
        },
        true,
    );
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (sortMenu.open || pickMenu.open || !periodMenu.hidden) {
                sortMenu.close();
                pickMenu.close();
                showPeriods(false);
            } else if (selected) select(undefined);
        }
        // up and down step through the processes in the inspector - unless they're
        // for something else, like the machine picker
        const forSomethingElse = (e.target as HTMLElement).closest('input, select, textarea');
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && tab === 'inspector' && !pickMenu.open && !forSomethingElse && procs.length) {
            e.preventDefault();
            const at = Math.max(0, procs.findIndex(p => p.key === (inspecting ?? procs[0].key)));
            const next = Math.min(procs.length - 1, Math.max(0, at + (e.key === 'ArrowUp' ? -1 : 1)));
            show('inspector', procs[next].key);
        }
    });
    $('forget').addEventListener('click', () => {
        const m = model?.machine;
        if (m && confirmForget(m.name)) db.forget(m.id).catch(showError);
    });

    $<HTMLFormElement>('pair-form').addEventListener('submit', e => {
        e.preventDefault();
        const input = $<HTMLInputElement>('pair-code');
        claim(input.value);
    });
    function claim(code: string) {
        $('pair-error').textContent = '';
        db.claim(code)
            .then(() => {
                history.replaceState(null, '', location.pathname); // the code's spent
                refresh();
            })
            .catch(err => ($('pair-error').textContent = err?.message ?? String(err)));
    }
    if (pair) {
        $<HTMLInputElement>('pair-code').value = pair;
        // as soon as there's a connection to claim it with
        const off = db.onChange(() => {
            if (db.status.state === 'connected') {
                off();
                claim(pair);
            }
        });
    }
}

// a button that opens a menu with a search box, like the design's sort menu. the
// menu's items are rendered by render (with whatever's been typed), each with a
// data-value that pick gets. up and down move through them, enter picks one
function dropdown(name: string, render: (query: string) => void, pick: (value: string) => void) {
    const box = $(`${name}-menu`), button = $(`${name}-open`), search = $<HTMLInputElement>(`${name}-search`), items = $(`${name}-items`);
    let active = 0; // the one enter would pick
    const options = () => [...items.querySelectorAll<HTMLElement>('[data-value]')];
    const menu = {
        query: '',
        get open() {
            return !box.hidden;
        },
        close: () => show(false),
        // after the items are drawn again, the active one's marked again. it's only
        // scrolled to when it moves - not on every redraw, under someone scrolling
        mark(scroll = false) {
            const all = options();
            active = Math.min(active, Math.max(0, all.length - 1));
            all.forEach((o, i) => o.classList.toggle('active', i === active));
            if (scroll && !box.hidden) all[active]?.scrollIntoView({block: 'nearest'});
        },
    };
    function show(on: boolean) {
        box.hidden = !on;
        button.setAttribute('aria-expanded', String(on));
        if (!on) return;
        menu.query = search.value = '';
        active = 0;
        render('');
        menu.mark(true);
        search.focus();
    }
    const choose = (value: string) => {
        show(false);
        pick(value);
    };
    button.addEventListener('click', () => show(box.hidden));
    search.addEventListener('input', () => {
        active = 0;
        render((menu.query = search.value));
        menu.mark(true);
    });
    search.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            active = Math.max(0, Math.min(options().length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            menu.mark(true);
        } else if (e.key === 'Enter') {
            const o = options()[active];
            if (o) choose(o.dataset.value!);
        }
    });
    items.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]');
        if (b) choose(b.dataset.value!);
    });
    document.addEventListener('mousedown', e => {
        if (!box.hidden && !box.parentElement!.contains(e.target as Node)) show(false);
    });
    return menu;
}

// a plain in-page confirm - browser dialogs block everything else
function confirmForget(name: string): boolean {
    const b = $('forget');
    if (b.dataset.armed) return true;
    b.dataset.armed = '1';
    b.textContent = `unpair ${name}? click again`;
    setTimeout(() => {
        delete b.dataset.armed;
        b.textContent = 'unpair';
    }, 4000);
    return false;
}

function showPairing(message?: string) {
    $('pairing').hidden = false;
    if (message) $('pair-error').textContent = message;
}

function hidePairing() {
    $('pairing').hidden = true;
}

function showError(err: unknown) {
    $('error').textContent = err instanceof Error ? err.message : String(err);
    setTimeout(() => ($('error').textContent = ''), 6000);
}

main().catch(showError);
