// the map: deck.gl over a basemap of ascii characters (ascii.ts) - no tile
// server, nothing loaded from anywhere else
import {Deck, MapView, WebMercatorViewport, type Layer, type PickingInfo} from '@deck.gl/core';
import {IconLayer, PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {TripsLayer} from '@deck.gl/geo-layers';
import {AsciiLayer, type AsciiPath} from './ascii';
import {themeRGB, themeVar, type RGB} from './theme';
import type {Cable, LonLat} from './geo';
import type {Drawn} from './paths';

export type {RGB};

// one remote endpoint, and the line to it
export type Line = {
    key: string;
    to: LonLat;
    drawn: Drawn;
    traced: boolean; // false: a plain great circle until a trace comes in
    color: RGB;
    weight: number; // 0-1, how much it's carried compared to the busiest
    active: boolean; // traffic in the last little while
    tracker: boolean;
    tooltip: string;
};

export type Trip = {key: string; path: LonLat[]; timestamps: number[]; color: RGB}; // key: its line's

export type Scene = {
    home?: LonLat;
    lines: Line[];
    trips: Trip[];
    cablesInUse: Set<string>;
    selected?: string;
    highlighted?: Set<string>; // e.g. everything one process talks to
    hovered?: string;
    showRoute?: boolean; // the selected line's routers - while its route is open in the card
    homeName?: string;
    homeLive?: boolean; // the agent's been heard from lately
};

// whether a line (and its packets) is what's being looked at: everything is until
// something's picked on the map or a process is pointed at, then only that
const inFocus = (s: Scene, key: string) => (!s.selected && !s.highlighted) || s.selected === key || !!s.highlighted?.has(key);

// the basemap's characters only stay sharp to about a pixel of the exported image
// each - past this zoom they'd just repeat
const MAX_ZOOM = 8;

// this machine: the design's square, in a dark ring so the lines meeting it stay
// apart from it, inside a viewfinder's corners - and while the agent's up, a ping
// going out from it. the icons are white so their colours can come from colors.css
const svgIcon = (id: string, size: number, body: string) => ({
    id,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${body}</svg>`)}`,
    width: size,
    height: size,
    mask: true,
});
const HOME = {square: 16, ring: 22, corners: 34, pingTo: 64, pingSeconds: 2.4};
const SQUARE = svgIcon('square', 32, '<rect width="32" height="32" fill="white"/>');
const CORNERS = svgIcon('corners', HOME.corners, `<path d="M1 9V1h8M${HOME.corners - 9} 1h8v8M${HOME.corners - 1} ${HOME.corners - 9}v8h-8M9 ${HOME.corners - 1}H1v-8" fill="none" stroke="white" stroke-width="1.5"/>`);
const OUTLINE = svgIcon('outline', HOME.pingTo, `<rect x="1" y="1" width="${HOME.pingTo - 2}" height="${HOME.pingTo - 2}" fill="none" stroke="white" stroke-width="1.5"/>`);

type HomePart = {at: LonLat; icon: typeof SQUARE; size: number; color: [number, number, number, number]; tooltip: string};

export class WorldMap {
    #deck: Deck<MapView>;
    #ascii: AsciiLayer;
    #asciiKey = '';
    #cableLines: {name: string; path: LonLat[]}[];
    #scene: Scene = {lines: [], trips: [], cablesInUse: new Set()};
    #time = 0;
    #flown = false;
    #fontReady = false; // the machine's name waits for roboto mono, or it'd be drawn in whatever's there first

    constructor(parent: HTMLDivElement, cables: Cable[], onPick: (key: string | undefined) => void, onHover: (key: string | undefined) => void) {
        this.#cableLines = cables.flatMap(c => c.lines.map(path => ({name: c.name, path})));
        // the characters go on their own canvases under deck's - the land, and the
        // connections over it
        const canvas = document.createElement('canvas');
        const lineCanvas = document.createElement('canvas');
        canvas.className = lineCanvas.className = 'ascii';
        parent.append(canvas, lineCanvas);
        this.#ascii = new AsciiLayer(canvas, lineCanvas);
        this.#deck = new Deck({
            parent,
            views: new MapView({repeat: true}),
            initialViewState: {longitude: -30, latitude: 25, zoom: 1.3, minZoom: 0.5, maxZoom: MAX_ZOOM},
            // no tilting or turning - the character grid is flat and north-up
            controller: {dragRotate: false, touchRotate: false},
            getCursor: ({isHovering}) => (isHovering ? 'pointer' : 'grab'),
            onClick: (info: PickingInfo) => onPick(info.object ? (info.object as {key?: string}).key : undefined),
            onHover: (info: PickingInfo) => onHover(info.object ? (info.object as {key?: string}).key : undefined),
            getTooltip: ({object}) => (object && 'tooltip' in object ? (object.tooltip as string) : null),
            // deck redraws every frame for the packets - the characters only when the view's moved
            onAfterRender: () => this.#drawAscii(),
        });
        // the world, straight away - before there's anything to draw on it
        this.setScene(this.#scene);
        document.fonts
            ?.load('500 11px "Roboto Mono"')
            .then(() => {
                this.#fontReady = true;
                this.setScene(this.#scene);
            })
            .catch(() => {});
    }

    setScene(scene: Scene) {
        this.#scene = scene;
        if (scene.home && !this.#flown) {
            this.#flown = true;
            this.#deck.setProps({initialViewState: {longitude: scene.home[0], latitude: scene.home[1] + 10, zoom: 1.6, minZoom: 0.5, maxZoom: MAX_ZOOM}});
        }
        this.#static = this.#layers(scene);
        this.#ascii.setPaths(this.#asciiPaths(scene));
        this.#draw();
    }

    // the connections, and the cables they cross, drawn in characters on the map
    // itself - the busiest last, so they win the cells they share
    #asciiPaths(s: Scene): AsciiPath[] {
        const focus = (key: string) => inFocus(s, key);
        const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
        return [
            ...this.#cableLines.filter(c => s.cablesInUse.has(c.name)).map(c => ({path: c.path, color: themeVar('--map-cable'), alpha: 0.7})),
            ...s.lines.map(l => ({
                path: l.drawn.path,
                legs: l.drawn.legs,
                key: l.key,
                color: css(l.color),
                alpha: !focus(l.key) ? 0.12 : l.active ? 0.85 + 0.15 * l.weight : 0.65,
                end: true,
                quiet: !l.active,
            })),
        ];
    }

    flyTo(longitude: number, latitude: number, zoom: number) {
        this.#deck.setProps({initialViewState: {longitude, latitude, zoom, minZoom: 0.5, maxZoom: MAX_ZOOM}});
    }

    // the basemap: the image the land's drawn from, and the borders on top - both
    // in dir. see ascii.ts
    loadAscii(dir: string) {
        return Promise.all([this.#ascii.load(`${dir}ascii-world.png`), this.#ascii.loadBorders(`${dir}borders.json`)]);
    }

    #drawAscii() {
        const vp = this.#deck.getViewports()[0];
        if (!(vp instanceof WebMercatorViewport)) return;
        const key = `${vp.width}x${vp.height}@${vp.longitude},${vp.latitude},${vp.zoom}`;
        if (key === this.#asciiKey) return;
        this.#asciiKey = key;
        const [x0, y0] = vp.project([-180, 85.0511]);
        const [x1, y1] = vp.project([180, -85.0511]);
        this.#ascii.draw({
            width: vp.width,
            height: vp.height,
            x0,
            worldWidth: x1 - x0,
            y0,
            worldHeight: y1 - y0,
            latAt: y => vp.unproject([vp.width / 2, y])[1],
        });
    }

    // packets move on their own - this is called every frame, and only rebuilds them
    setTime(seconds: number) {
        this.#time = seconds;
        this.#draw();
    }

    #static: Layer[] = [];

    #draw() {
        const s = this.#scene;
        this.#deck.setProps({
            layers: [
                ...this.#static,
                new TripsLayer<Trip>({
                    id: 'packets',
                    data: s.trips,
                    getPath: d => d.path,
                    getTimestamps: d => d.timestamps,
                    // faded with their lines when something else is being looked at
                    getColor: d => (inFocus(s, d.key) ? d.color : [...d.color, 30]),
                    updateTriggers: {getColor: [s.selected, s.highlighted]},
                    currentTime: this.#time,
                    trailLength: 0.18,
                    fadeTrail: true,
                    capRounded: true,
                    getWidth: 2.5,
                    widthUnits: 'pixels',
                }),
                this.#ping(),
                ...this.#homeLayers,
            ],
        });
    }

    #homeLayers: Layer[] = [];

    // a square going out from this machine and fading, over and over, while the agent's up
    #ping() {
        const s = this.#scene;
        const t = ((performance.now() / 1000) % HOME.pingSeconds) / HOME.pingSeconds;
        const color = themeRGB('--map-home-square');
        return new IconLayer<HomePart>({
            id: 'home-ping',
            data: s.home && s.homeLive ? [{at: s.home, icon: OUTLINE, size: HOME.ring + (HOME.pingTo - HOME.ring) * t, color: [...color, Math.round(170 * (1 - t) ** 1.5)], tooltip: ''}] : [],
            getPosition: d => d.at,
            getIcon: d => d.icon,
            getSize: d => d.size,
            sizeUnits: 'pixels',
            getColor: d => d.color,
            updateTriggers: {getSize: t, getColor: t},
        });
    }

    // everything but the packets - only rebuilt when the data changes, so each
    // frame hands deck the same objects and it has nothing to redo
    #layers(s: Scene): Layer[] {
        const focus = (key: string) => inFocus(s, key);
        const alpha = (l: Line) => (focus(l.key) ? (l.active ? 230 : 110) : 30);
        // endpoints only get a dot (and a tracker's outline) once something points at them
        const picked = s.lines.filter(l => s.selected === l.key || s.hovered === l.key || !!s.highlighted?.has(l.key));
        // from colors.css, every time the layers are built
        const COLORS = {
            home: themeRGB('--map-home'),
            homeSquare: themeRGB('--map-home-square'),
            sea: themeRGB('--map-bg'),
            tracker: themeRGB('--map-tracker'),
        };

        // dimmer while the agent's quiet
        const tooltip = `this machine${s.homeName ? ` - ${s.homeName}` : ''}${s.homeLive ? '' : ' (agent offline)'}`;
        const home: HomePart[] = s.home
            ? [
                  {at: s.home, icon: CORNERS, size: HOME.corners, color: [...COLORS.homeSquare, s.homeLive ? 150 : 70], tooltip},
                  {at: s.home, icon: SQUARE, size: HOME.ring, color: [...COLORS.sea, 255], tooltip},
                  {at: s.home, icon: SQUARE, size: HOME.square, color: [...COLORS.homeSquare, s.homeLive ? 255 : 130], tooltip},
              ]
            : [];
        this.#homeLayers = [
            new IconLayer<HomePart>({
                id: 'home',
                data: home,
                pickable: true,
                getPosition: d => d.at,
                getIcon: d => d.icon,
                getSize: d => d.size,
                sizeUnits: 'pixels',
                getColor: d => d.color,
            }),
            // its name underneath, lowercase like everything else
            new TextLayer<{at: LonLat; text: string}>({
                id: 'home-name',
                data: s.home && s.homeName && this.#fontReady ? [{at: s.home, text: s.homeName.toLowerCase()}] : [],
                getPosition: d => d.at,
                getText: d => d.text,
                getSize: 11,
                getPixelOffset: [0, HOME.corners / 2 + 10],
                getColor: [...COLORS.homeSquare, s.homeLive ? 230 : 130],
                fontFamily: '"Roboto Mono", ui-monospace, monospace',
                fontWeight: 500,
                fontSettings: {sdf: true},
                outlineWidth: 4,
                outlineColor: [...COLORS.sea, 230],
            }),
        ];

        return [
            // the lines themselves are characters on the map (see #asciiPaths) - these are
            // what the mouse finds, wider than they look, and only show as a soft glow
            // under the one picked or pointed at
            new PathLayer<Line>({
                id: 'lines',
                data: s.lines,
                pickable: true,
                getPath: d => d.drawn.path,
                getColor: d => [...d.color, s.selected === d.key || s.hovered === d.key ? 70 : 1],
                getWidth: d => (s.selected === d.key || s.hovered === d.key ? 7 : 10),
                widthUnits: 'pixels',
                capRounded: true,
                jointRounded: true,
                updateTriggers: {getColor: [s.selected, s.hovered], getWidth: [s.selected, s.hovered]},
            }),
            new ScatterplotLayer<Line>({
                id: 'endpoints',
                data: picked,
                pickable: true,
                getPosition: d => d.drawn.path[d.drawn.path.length - 1],
                getRadius: d => 2.5 + 5 * d.weight,
                radiusUnits: 'pixels',
                getFillColor: d => [...d.color, alpha(d)],
                stroked: true,
                getLineColor: d => (d.tracker ? [...COLORS.tracker, 255] : [0, 0, 0, 0]),
                lineWidthUnits: 'pixels',
                getLineWidth: 1.5,
            }),
            // the routers on the selected line's route, while it's open in the card
            new ScatterplotLayer<{at: LonLat}>({
                id: 'hops',
                data: s.showRoute ? (s.lines.find(l => l.key === s.selected)?.drawn.stops ?? []) : [],
                getPosition: d => d.at,
                getRadius: 3,
                radiusUnits: 'pixels',
                getFillColor: [...COLORS.home, 220],
            }),
        ];
    }
}
