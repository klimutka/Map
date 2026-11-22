/* Winterhold Road Navigator V3
 * Client-side test navigator for a Leaflet CRS.Simple atlas.
 * Routes are calculated exclusively on the supplied road geometry and junction topology.
 */
(function (root) {
  'use strict';

  const CONFIG = Object.freeze({
    // Relative speed factors. Main roads are treated as 28% faster than secondary roads.
    // These are routing weights, not calibrated real-world or in-game ETA values.
    SPEED_FACTORS: { main: 1.28, secondary: 1.0 },
    MAX_SNAP_SCREEN_PX: 82,
    ROUTE_LINE: { glow: '#8f78ee', casing: '#211b36', gold: '#9578ef', highlight: '#f1eaff' }
  });

  function pointDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function lineLength(coords) {
    let sum = 0;
    for (let i = 1; i < coords.length; i++) sum += pointDistance(coords[i - 1], coords[i]);
    return sum;
  }

  function nearestVertexIndex(coords, point) {
    let bestIndex = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const dx = coords[i][0] - point[0];
      const dy = coords[i][1] - point[1];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIndex = i; }
    }
    return { index: bestIndex, distance: Math.sqrt(bestD2) };
  }

  function addNode(nodes, id, x, y, kind) {
    if (!nodes.has(id)) nodes.set(id, { id, x, y, kind: kind || 'junction' });
  }

  function buildGraph(network, topology) {
    const nodes = new Map();
    const edges = [];
    const junctions = new Map((topology && Array.isArray(topology.junctions) ? topology.junctions : [])
      .map(j => [j.id, j]));

    junctions.forEach(j => addNode(nodes, j.id, Number(j.lng), Number(j.lat), 'junction'));

    (network && Array.isArray(network.features) ? network.features : []).forEach(feature => {
      const props = feature.properties || {};
      if (String(props.status || '').toLowerCase() === 'rejected') return;
      if (!feature.geometry || feature.geometry.type !== 'LineString') return;
      const coords = (feature.geometry.coordinates || []).filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1])).map(c => [+c[0], +c[1]]);
      if (coords.length < 2) return;

      const uniqueRefs = new Set();
      const anchors = [];
      (props.junction_refs || props.junctionRefs || []).forEach(ref => {
        const junctionId = ref.junction_id || ref.junctionId;
        const j = junctions.get(junctionId);
        if (!j || uniqueRefs.has(junctionId)) return;
        uniqueRefs.add(junctionId);
        const nearest = nearestVertexIndex(coords, [Number(j.lng), Number(j.lat)]);
        anchors.push({ index: nearest.index, id: junctionId });
      });
      anchors.sort((a, b) => a.index - b.index);

      const roadId = String(props.id || ('road-' + edges.length));
      const roadName = String(props.name || 'Дорога');
      const kind = props.kind === 'main' ? 'main' : 'secondary';
      const speedFactor = CONFIG.SPEED_FACTORS[kind];
      const cuts = [];

      // Preserve unconnected line ends as dead-end graph nodes. They are not linked
      // to nearby roads unless the editor has created an explicit junction.
      if (!anchors.length || anchors[0].index > 0) {
        const id = '@endpoint:' + roadId + ':start';
        addNode(nodes, id, coords[0][0], coords[0][1], 'endpoint');
        cuts.push({ index: 0, id });
      }
      anchors.forEach(a => cuts.push({ index: a.index, id: a.id }));
      if (!anchors.length || anchors[anchors.length - 1].index < coords.length - 1) {
        const id = '@endpoint:' + roadId + ':end';
        addNode(nodes, id, coords[coords.length - 1][0], coords[coords.length - 1][1], 'endpoint');
        cuts.push({ index: coords.length - 1, id });
      }

      // Collapse adjacent anchors that map to the same sampled vertex. The coordinates
      // are near-identical; keeping one would disconnect an alias, so retain a tiny link.
      cuts.sort((a, b) => a.index - b.index);
      for (let i = 1; i < cuts.length; i++) {
        const a = cuts[i - 1], b = cuts[i];
        if (a.id === b.id) continue;
        const segment = coords.slice(a.index, b.index + 1);
        const nodeA = nodes.get(a.id), nodeB = nodes.get(b.id);
        if (!segment.length) continue;
        segment[0] = [nodeA.x, nodeA.y];
        segment[segment.length - 1] = [nodeB.x, nodeB.y];
        let length = lineLength(segment);
        if (length < 1e-5) length = pointDistance([nodeA.x, nodeA.y], [nodeB.x, nodeB.y]);
        if (length < 1e-5) length = 0.001;
        edges.push({
          id: roadId + ':' + i,
          a: a.id,
          b: b.id,
          coords: segment,
          length,
          weight: length / speedFactor,
          roadId,
          roadName,
          kind,
          speedFactor,
          status: props.status || 'candidate'
        });
      }
    });

    const adjacency = new Map();
    nodes.forEach((_, id) => adjacency.set(id, []));
    edges.forEach(edge => {
      if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
      if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
      adjacency.get(edge.a).push(edge);
      adjacency.get(edge.b).push(edge);
    });

    const componentByNode = new Map();
    let componentCount = 0;
    nodes.forEach((_, nodeId) => {
      if (componentByNode.has(nodeId) || !(adjacency.get(nodeId) || []).length) return;
      const stack = [nodeId];
      componentByNode.set(nodeId, componentCount);
      while (stack.length) {
        const current = stack.pop();
        (adjacency.get(current) || []).forEach(edge => {
          const next = edge.a === current ? edge.b : edge.a;
          if (!componentByNode.has(next)) {
            componentByNode.set(next, componentCount);
            stack.push(next);
          }
        });
      }
      componentCount++;
    });

    return { nodes, edges, adjacency, componentByNode, componentCount };
  }

  function nearestRoadSnap(graph, x, y, maxDistance) {
    let best = null;
    graph.edges.forEach(edge => {
      let walked = 0;
      const coords = edge.coords;
      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const segLen2 = dx * dx + dy * dy;
        const segLen = Math.sqrt(segLen2);
        let t = segLen2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / segLen2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + dx * t;
        const py = a[1] + dy * t;
        const d = Math.hypot(x - px, y - py);
        if (!best || d < best.distance) {
          best = {
            edge,
            x: px,
            y: py,
            distance: d,
            distanceAlong: walked + segLen * t,
            roadId: edge.roadId,
            roadName: edge.roadName,
            kind: edge.kind
          };
        }
        walked += segLen;
      }
    });
    if (!best || best.distance > maxDistance) return null;
    return best;
  }

  function pointAtDistance(coords, target) {
    if (target <= 0) return coords[0].slice();
    let walked = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const len = pointDistance(a, b);
      if (walked + len >= target) {
        const t = len > 0 ? (target - walked) / len : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      walked += len;
    }
    return coords[coords.length - 1].slice();
  }

  function slicePolyline(coords, fromDistance, toDistance) {
    const total = lineLength(coords);
    const start = Math.max(0, Math.min(total, fromDistance));
    const end = Math.max(start, Math.min(total, toDistance));
    const out = [pointAtDistance(coords, start)];
    let walked = 0;
    for (let i = 1; i < coords.length - 1; i++) {
      walked += pointDistance(coords[i - 1], coords[i]);
      if (walked > start + 1e-7 && walked < end - 1e-7) out.push(coords[i].slice());
    }
    const endPoint = pointAtDistance(coords, end);
    if (pointDistance(out[out.length - 1], endPoint) > 1e-7) out.push(endPoint);
    return out;
  }

  function findRoute(graph, startSnap, endSnap) {
    if (!startSnap || !endSnap) return null;
    const startId = '@route:start';
    const endId = '@route:end';
    const nodes = new Map(graph.nodes);
    nodes.set(startId, { id: startId, x: startSnap.x, y: startSnap.y, kind: 'route-point' });
    nodes.set(endId, { id: endId, x: endSnap.x, y: endSnap.y, kind: 'route-point' });

    const snapsByEdge = new Map();
    [[startSnap, startId], [endSnap, endId]].forEach(pair => {
      const snap = pair[0], nodeId = pair[1];
      if (!snapsByEdge.has(snap.edge.id)) snapsByEdge.set(snap.edge.id, []);
      snapsByEdge.get(snap.edge.id).push({ nodeId, distance: snap.distanceAlong, x: snap.x, y: snap.y });
    });

    const adjacency = new Map();
    nodes.forEach((_, id) => adjacency.set(id, []));
    function addEdge(edge) {
      adjacency.get(edge.a).push(edge);
      adjacency.get(edge.b).push(edge);
    }

    graph.edges.forEach(edge => {
      const snaps = snapsByEdge.get(edge.id);
      if (!snaps || !snaps.length) { addEdge(edge); return; }
      snaps.sort((a, b) => a.distance - b.distance);
      const cuts = [{ nodeId: edge.a, distance: 0 }];
      snaps.forEach(s => cuts.push(s));
      cuts.push({ nodeId: edge.b, distance: edge.length });
      for (let i = 1; i < cuts.length; i++) {
        const a = cuts[i - 1], b = cuts[i];
        if (a.nodeId === b.nodeId) continue;
        const d0 = Math.max(0, Math.min(edge.length, a.distance));
        const d1 = Math.max(d0, Math.min(edge.length, b.distance));
        const coords = slicePolyline(edge.coords, d0, d1);
        if (coords.length < 2) coords.push(coords[0].slice());
        addEdge({
          id: edge.id + ':split:' + i,
          a: a.nodeId,
          b: b.nodeId,
          coords,
          length: Math.max(0, d1 - d0),
          weight: Math.max(0, d1 - d0) / edge.speedFactor,
          roadId: edge.roadId,
          roadName: edge.roadName,
          kind: edge.kind,
          speedFactor: edge.speedFactor,
          status: edge.status
        });
      }
    });

    // Dijkstra: all route edges are existing road segments; no straight-line fallback.
    const dist = new Map();
    const previous = new Map();
    const visited = new Set();
    nodes.forEach((_, id) => dist.set(id, Infinity));
    dist.set(startId, 0);

    for (let step = 0; step < nodes.size; step++) {
      let current = null;
      let best = Infinity;
      dist.forEach((value, id) => {
        if (!visited.has(id) && value < best) { best = value; current = id; }
      });
      if (current === null || !Number.isFinite(best)) break;
      if (current === endId) break;
      visited.add(current);
      (adjacency.get(current) || []).forEach(edge => {
        const next = edge.a === current ? edge.b : edge.a;
        if (visited.has(next)) return;
        const alt = best + edge.weight;
        if (alt < dist.get(next)) {
          dist.set(next, alt);
          previous.set(next, { from: current, edge });
        }
      });
    }

    if (!Number.isFinite(dist.get(endId))) return null;
    const path = [];
    let cursor = endId;
    while (cursor !== startId) {
      const prev = previous.get(cursor);
      if (!prev) return null;
      const edge = prev.edge;
      const forward = edge.a === prev.from;
      path.push({
        ...edge,
        coords: forward ? edge.coords.map(c => c.slice()) : edge.coords.slice().reverse().map(c => c.slice()),
        from: prev.from,
        to: cursor
      });
      cursor = prev.from;
    }
    path.reverse();
    const coordinates = [];
    path.forEach(part => part.coords.forEach((c, i) => {
      if (!coordinates.length || pointDistance(coordinates[coordinates.length - 1], c) > 1e-6) coordinates.push(c);
    }));
    return {
      path,
      coordinates,
      distance: path.reduce((s, edge) => s + edge.length, 0),
      weightedCost: dist.get(endId),
      start: { x: startSnap.x, y: startSnap.y },
      end: { x: endSnap.x, y: endSnap.y }
    };
  }

  function makePointIcon(L, letter, variant) {
    return L.divIcon({
      className: 'winterhold-route-point-icon ' + variant,
      html: '<span>' + letter + '</span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function attach(map, L, network, topology) {
    let graph = buildGraph(network, topology);
    let pickMode = null;
    let startSnap = null;
    let endSnap = null;
    let startMarker = null;
    let endMarker = null;
    let routeLayers = [];

    if (!map.getPane('winterholdRouteHaloPane')) map.createPane('winterholdRouteHaloPane');
    if (!map.getPane('winterholdRoutePane')) map.createPane('winterholdRoutePane');
    if (!map.getPane('winterholdRouteHighlightPane')) map.createPane('winterholdRouteHighlightPane');
    map.getPane('winterholdRouteHaloPane').style.zIndex = 420;
    map.getPane('winterholdRoutePane').style.zIndex = 430;
    map.getPane('winterholdRouteHighlightPane').style.zIndex = 440;

    const Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const box = L.DomUtil.create('section', 'winterhold-navigator-control');
        box.setAttribute('aria-label', 'Навигатор Скайрима');
        box.innerHTML = `
          <div class="wnav-head">
            <div class="wnav-emblem">✦</div>
            <div class="wnav-heading"><strong>НАВИГАТОР</strong><small>Путь по дорогам Скайрима</small></div>
          </div>
          <div class="wnav-points">
            <div class="wnav-point-row">
              <span class="wnav-point-badge wnav-a">A</span>
              <div class="wnav-point-copy"><b>Отправление</b><small id="wnav-start-label">Не выбрана</small></div>
              <button type="button" id="wnav-pick-start" class="wnav-pick-btn">Выбрать</button>
            </div>
            <div class="wnav-point-row">
              <span class="wnav-point-badge wnav-b">B</span>
              <div class="wnav-point-copy"><b>Назначение</b><small id="wnav-end-label">Не выбрано</small></div>
              <button type="button" id="wnav-pick-end" class="wnav-pick-btn">Выбрать</button>
            </div>
          </div>
          <div class="wnav-actions">
            <button type="button" id="wnav-build" class="wnav-build-btn" disabled>Построить маршрут</button>
            <button type="button" id="wnav-clear" class="wnav-clear-btn">Сброс</button>
          </div>
          <div class="wnav-status" id="wnav-status">Выберите точки A и B на карте.</div>
        `;
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);

        const startLabel = box.querySelector('#wnav-start-label');
        const endLabel = box.querySelector('#wnav-end-label');
        const status = box.querySelector('#wnav-status');
        const buildButton = box.querySelector('#wnav-build');

        function setStatus(text, mode) {
          status.textContent = text;
          status.className = 'wnav-status' + (mode ? ' ' + mode : '');
        }

        function clearRouteLayers() {
          routeLayers.forEach(layer => { if (map.hasLayer(layer)) map.removeLayer(layer); });
          routeLayers = [];
        }

        function clearPointMarkers() {
          [startMarker, endMarker].forEach(marker => { if (marker && map.hasLayer(marker)) map.removeLayer(marker); });
          startMarker = endMarker = null;
        }

        function renderPoint(snap, letter) {
          const isStart = letter === 'A';
          const marker = L.marker([snap.y, snap.x], {
            icon: makePointIcon(L, letter, isStart ? 'wnav-marker-start' : 'wnav-marker-end'),
            keyboard: false,
            zIndexOffset: 1400
          }).addTo(map);
          return marker;
        }

        function updatePointLabels() {
          startLabel.textContent = startSnap ? 'Привязана к дороге' : 'Не выбрана';
          endLabel.textContent = endSnap ? 'Привязан к дороге' : 'Не выбран';
          buildButton.disabled = !(startSnap && endSnap);
        }

        function setPoint(which, snap) {
          clearRouteLayers();
          if (which === 'start') {
            if (startMarker && map.hasLayer(startMarker)) map.removeLayer(startMarker);
            startSnap = snap;
            startMarker = renderPoint(snap, 'A');
          } else {
            if (endMarker && map.hasLayer(endMarker)) map.removeLayer(endMarker);
            endSnap = snap;
            endMarker = renderPoint(snap, 'B');
          }
          updatePointLabels();
          setStatus(which === 'start' ? 'Точка A выбрана.' : 'Точка B выбрана.', 'is-good');
        }

        function showRoute(route) {
          clearRouteLayers();
          const latlngs = route.coordinates.map(c => [c[1], c[0]]);
          const styles = [
            { pane: 'winterholdRouteHaloPane', color: CONFIG.ROUTE_LINE.glow, weight: 11, opacity: .30, className: 'winterhold-route-glow' },
            { pane: 'winterholdRoutePane', color: CONFIG.ROUTE_LINE.casing, weight: 5.2, opacity: .88, className: 'winterhold-route-casing' },
            { pane: 'winterholdRoutePane', color: CONFIG.ROUTE_LINE.gold, weight: 3.25, opacity: 1, className: 'winterhold-route-gold' },
            { pane: 'winterholdRouteHighlightPane', color: CONFIG.ROUTE_LINE.highlight, weight: .82, opacity: .92, className: 'winterhold-route-glint' }
          ];
          styles.forEach(style => routeLayers.push(L.polyline(latlngs, {
            ...style,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: .18,
            interactive: false
          }).addTo(map)));
          map.fitBounds(routeLayers[0].getBounds(), {
            paddingTopLeft: [28, 28],
            paddingBottomRight: [window.innerWidth <= 700 ? 286 : 306, 28],
            maxZoom: Math.max(map.getZoom(), 5),
            animate: true,
            duration: .6
          });
        }

        function build() {
          if (!startSnap || !endSnap) return;
          const route = findRoute(graph, startSnap, endSnap);
          if (!route) {
            clearRouteLayers();
              setStatus('Маршрут не найден: между точками нет непрерывной дороги.', 'is-warning');
            return;
          }
          showRoute(route);
          setStatus('Маршрут построен', 'is-good');
        }

        function reset() {
          pickMode = null;
          startSnap = endSnap = null;
          clearRouteLayers();
          clearPointMarkers();
          updatePointLabels();
          setStatus('Выберите точки A и B на карте.');
          map.getContainer().style.cursor = '';
        }

        function beginPick(which) {
          pickMode = which;
          map.getContainer().style.cursor = 'crosshair';
          setStatus(which === 'start' ? 'Выберите точку A на карте.' : 'Выберите точку B на карте.');
        }

        L.DomEvent.on(box.querySelector('#wnav-pick-start'), 'click', () => beginPick('start'));
        L.DomEvent.on(box.querySelector('#wnav-pick-end'), 'click', () => beginPick('end'));
        L.DomEvent.on(buildButton, 'click', build);
        L.DomEvent.on(box.querySelector('#wnav-clear'), 'click', reset);

        this._box = box;
        this._setStatus = setStatus;
        this._setPoint = setPoint;
        this._getPickMode = () => pickMode;
        this._beginPick = beginPick;
        this._endPick = () => { pickMode = null; map.getContainer().style.cursor = ''; };
        this._reset = reset;
        this._graph = graph;
        this._build = build;
        this._updatePoints = updatePointLabels;
        this._renderPoint = renderPoint;
        this._startSnapRef = () => startSnap;
        this._endSnapRef = () => endSnap;
        return box;
      }
    });

    const control = new Control();
    control.addTo(map);
    function handleMapClick(e) {
      const mode = control._getPickMode();
      if (!mode) return false;
      const x = Number(e.latlng.lng), y = Number(e.latlng.lat);
      const scale = Math.pow(2, map.getZoom()) / 16;
      const snapLimit = CONFIG.MAX_SNAP_SCREEN_PX / Math.max(scale, 0.0001);
      const snap = nearestRoadSnap(graph, x, y, snapLimit);
      if (!snap) {
        control._setStatus('В этом месте нет дороги. Выберите точку ближе к дорожной линии.', 'is-warning');
        return true;
      }
      control._setPoint(mode, snap);
      if (mode === 'start' && !control._endSnapRef()) {
        control._beginPick('end');
        control._box.querySelector('#wnav-pick-end').classList.add('is-next');
        control._setStatus('Точка A выбрана. Теперь выберите B.');
      } else {
        control._endPick();
        control._box.querySelector('#wnav-pick-end').classList.remove('is-next');
      }
      return true;
    }

    console.info('[Winterhold Navigator V3] Graph ready', {
      roads: new Set(graph.edges.map(e => e.roadId)).size,
      edges: graph.edges.length,
      nodes: graph.nodes.size,
      components: graph.componentCount
    });

    return {
      get graph() { return graph; },
      setNetwork: (nextNetwork, nextTopology) => {
        graph = buildGraph(nextNetwork, nextTopology);
        control._graph = graph;
        control._reset();
        console.info('[Winterhold Navigator V3] Road graph updated', {
          roads: new Set(graph.edges.map(e => e.roadId)).size,
          edges: graph.edges.length,
          nodes: graph.nodes.size,
          components: graph.componentCount
        });
        return { roads: new Set(graph.edges.map(e => e.roadId)).size, edges: graph.edges.length, nodes: graph.nodes.size, components: graph.componentCount };
      },
      handleMapClick,
      reset: () => control._reset(),
      buildRoute: () => control._build(),
      config: CONFIG
    };
  }

  root.WinterholdRoadNavigator = { CONFIG, buildGraph, nearestRoadSnap, findRoute, attach };
})(typeof window !== 'undefined' ? window : globalThis);
