/* Winterhold Road Navigator V2
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
    ROUTE_LINE: { halo: '#14232a', gold: '#e9c477', highlight: '#fff2cf' }
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

  function roadDisplayName(edge) {
    if (edge.roadName && !/^Новая дорога\s+\d+$/i.test(edge.roadName)) return 'дороге «' + edge.roadName + '»';
    return edge.kind === 'main' ? 'главной дороге' : 'второстепенной дороге';
  }

  function buildInstructions(path) {
    const groups = [];
    path.forEach(edge => {
      const last = groups[groups.length - 1];
      if (last && last.roadId === edge.roadId) {
        last.distance += edge.length;
        last.edges.push(edge);
      } else {
        groups.push({ roadId: edge.roadId, roadName: edge.roadName, kind: edge.kind, distance: edge.length, edges: [edge] });
      }
    });
    const steps = [];
    groups.forEach((group, index) => {
      const label = roadDisplayName(group);
      if (index === 0) {
        steps.push({ icon: 'flag', text: 'Начните движение по ' + label, distance: group.distance });
      } else {
        const prev = groups[index - 1];
        const prevCoords = prev.edges[prev.edges.length - 1].coords;
        const nextCoords = group.edges[0].coords;
        const a = prevCoords[Math.max(0, prevCoords.length - 2)];
        const b = prevCoords[prevCoords.length - 1];
        const c = nextCoords[Math.min(1, nextCoords.length - 1)];
        const inX = b[0] - a[0], inY = -(b[1] - a[1]);
        const outX = c[0] - b[0], outY = -(c[1] - b[1]);
        const cross = inX * outY - inY * outX;
        const dot = inX * outX + inY * outY;
        const angle = Math.atan2(cross, dot) * 180 / Math.PI;
        let text;
        if (Math.abs(angle) < 28) text = 'Продолжайте движение по ' + label;
        else if (angle > 145 || angle < -145) text = 'Развернитесь и следуйте по ' + label;
        else if (angle < 0) text = 'Поверните налево на ' + label;
        else text = 'Поверните направо на ' + label;
        steps.push({ icon: 'turn', text, distance: group.distance });
      }
    });
    steps.push({ icon: 'finish', text: 'Вы прибыли в пункт назначения', distance: 0 });
    return steps;
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
    const graph = buildGraph(network, topology);
    let pickMode = null;
    let startSnap = null;
    let endSnap = null;
    let startMarker = null;
    let endMarker = null;
    let routeLayers = [];
    let routeArrowMarkers = [];

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
            <div class="wnav-emblem">✧</div>
            <div class="wnav-heading"><strong>НАВИГАТОР</strong><small>Путь по дорогам Скайрима</small></div>
            <span class="wnav-demo">ТЕСТ</span>
          </div>
          <div class="wnav-points">
            <div class="wnav-point-row">
              <span class="wnav-point-badge wnav-a">A</span>
              <div class="wnav-point-copy"><b>Точка отправления</b><small id="wnav-start-label">Не выбрана</small></div>
              <button type="button" id="wnav-pick-start" class="wnav-pick-btn">Выбрать</button>
            </div>
            <div class="wnav-point-row">
              <span class="wnav-point-badge wnav-b">B</span>
              <div class="wnav-point-copy"><b>Пункт назначения</b><small id="wnav-end-label">Не выбран</small></div>
              <button type="button" id="wnav-pick-end" class="wnav-pick-btn">Выбрать</button>
            </div>
          </div>
          <div class="wnav-actions">
            <button type="button" id="wnav-build" class="wnav-build-btn" disabled>Построить маршрут</button>
            <button type="button" id="wnav-clear" class="wnav-clear-btn">Сбросить</button>
          </div>
          <div class="wnav-status" id="wnav-status">Выберите A и B на карте. Точки будут привязаны к ближайшей дороге.</div>
          <div class="wnav-result" id="wnav-result" hidden>
            <div class="wnav-result-head"><span class="wnav-result-check">✓</span><strong>Маршрут построен</strong></div>
            <div class="wnav-stats"><div><small>Длина пути</small><b id="wnav-distance">—</b></div><div><small>Участков</small><b id="wnav-segment-count">—</b></div></div>
            <div class="wnav-fastest">Выбирается путь с минимальным временем: главные дороги имеют больший скоростной приоритет, чем второстепенные.</div>
            <ol class="wnav-steps" id="wnav-steps"></ol>
          </div>
          <div class="wnav-foot">Тестовая сеть: 122 линии, ${graph.componentCount} отдельные связные части. Дороги скрыты — показывается только построенный маршрут.</div>
        `;
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);

        const startLabel = box.querySelector('#wnav-start-label');
        const endLabel = box.querySelector('#wnav-end-label');
        const status = box.querySelector('#wnav-status');
        const buildButton = box.querySelector('#wnav-build');
        const resultBox = box.querySelector('#wnav-result');
        const stepsBox = box.querySelector('#wnav-steps');

        function setStatus(text, mode) {
          status.textContent = text;
          status.className = 'wnav-status' + (mode ? ' ' + mode : '');
        }

        function clearRouteLayers() {
          routeLayers.forEach(layer => { if (map.hasLayer(layer)) map.removeLayer(layer); });
          routeLayers = [];
          routeArrowMarkers.forEach(marker => { if (map.hasLayer(marker)) map.removeLayer(marker); });
          routeArrowMarkers = [];
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
          resultBox.hidden = true;
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
          const roadLabel = snap.kind === 'main' ? 'главная дорога' : 'второстепенная дорога';
          setStatus((which === 'start' ? 'Точка A' : 'Точка B') + ' привязана к ' + roadLabel + '. ' + (startSnap && endSnap ? 'Теперь постройте маршрут.' : 'Выберите вторую точку.'), 'is-good');
        }

        function addArrowMarkers(coords) {
          const total = lineLength(coords);
          if (total < 450) return;
          const count = Math.min(8, Math.max(1, Math.floor(total / 650)));
          for (let n = 1; n <= count; n++) {
            const d = total * n / (count + 1);
            const p = pointAtDistance(coords, d);
            const before = pointAtDistance(coords, Math.max(0, d - 8));
            const after = pointAtDistance(coords, Math.min(total, d + 8));
            const angle = Math.atan2(-(after[1] - before[1]), after[0] - before[0]) * 180 / Math.PI;
            const icon = L.divIcon({
              className: 'winterhold-route-arrow',
              html: '<span style="transform:rotate(' + angle.toFixed(1) + 'deg)">➤</span>',
              iconSize: [18, 18],
              iconAnchor: [9, 9]
            });
            routeArrowMarkers.push(L.marker([p[1], p[0]], { icon, interactive: false, keyboard: false, zIndexOffset: 1100 }).addTo(map));
          }
        }

        function showRoute(route) {
          clearRouteLayers();
          const latlngs = route.coordinates.map(c => [c[1], c[0]]);
          const styles = [
            { pane: 'winterholdRouteHaloPane', color: CONFIG.ROUTE_LINE.halo, weight: 13, opacity: .88 },
            { pane: 'winterholdRoutePane', color: CONFIG.ROUTE_LINE.gold, weight: 7, opacity: .98 },
            { pane: 'winterholdRouteHighlightPane', color: CONFIG.ROUTE_LINE.highlight, weight: 1.35, opacity: .82 }
          ];
          styles.forEach(style => routeLayers.push(L.polyline(latlngs, {
            ...style,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: .35,
            interactive: false
          }).addTo(map)));
          addArrowMarkers(route.coordinates);
          map.fitBounds(routeLayers[0].getBounds(), {
            paddingTopLeft: [36, 36],
            paddingBottomRight: [window.innerWidth <= 700 ? 320 : 360, 36],
            maxZoom: Math.max(map.getZoom(), 5),
            animate: true,
            duration: .6
          });
        }

        function renderInstructions(route) {
          const instructions = buildInstructions(route.path);
          stepsBox.innerHTML = '';
          instructions.forEach((step, index) => {
            const li = document.createElement('li');
            li.className = 'wnav-step';
            const icon = document.createElement('span');
            icon.className = 'wnav-step-icon ' + (step.icon === 'flag' ? 'is-start' : step.icon === 'finish' ? 'is-finish' : 'is-turn');
            icon.textContent = step.icon === 'flag' ? 'A' : step.icon === 'finish' ? 'B' : (step.text.includes('налево') ? '↶' : step.text.includes('направо') ? '↷' : '↑');
            const content = document.createElement('span');
            content.className = 'wnav-step-text';
            content.textContent = step.text;
            const distance = document.createElement('small');
            distance.textContent = step.distance > 0 ? Math.round(step.distance).toLocaleString('ru-RU') + ' ед.' : '';
            li.append(icon, content, distance);
            stepsBox.appendChild(li);
          });
        }

        function build() {
          if (!startSnap || !endSnap) return;
          const route = findRoute(graph, startSnap, endSnap);
          if (!route) {
            clearRouteLayers();
            resultBox.hidden = true;
            setStatus('Маршрут не найден: точки находятся в разных частях дорожной сети. Возможно, между дорогами не хватает соединительного узла.', 'is-warning');
            return;
          }
          showRoute(route);
          box.querySelector('#wnav-distance').textContent = Math.round(route.distance).toLocaleString('ru-RU') + ' ед.';
          box.querySelector('#wnav-segment-count').textContent = String(new Set(route.path.map(e => e.roadId)).size);
          renderInstructions(route);
          resultBox.hidden = false;
          setStatus('Маршрут рассчитан по существующим линиям. Прямых участков вне дорог нет.', 'is-good');
        }

        function reset() {
          pickMode = null;
          startSnap = endSnap = null;
          clearRouteLayers();
          clearPointMarkers();
          resultBox.hidden = true;
          stepsBox.innerHTML = '';
          updatePointLabels();
          setStatus('Выберите A и B на карте. Точки будут привязаны к ближайшей дороге.');
          map.getContainer().style.cursor = '';
        }

        function beginPick(which) {
          pickMode = which;
          map.getContainer().style.cursor = 'crosshair';
          setStatus(which === 'start' ? 'Кликните по карте рядом с дорогой, чтобы поставить точку A.' : 'Кликните по карте рядом с дорогой, чтобы поставить точку B.');
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
        control._setStatus('Рядом нет дороги. Приблизьте карту и выберите точку ближе к линии.', 'is-warning');
        return true;
      }
      control._setPoint(mode, snap);
      if (mode === 'start' && !control._endSnapRef()) {
        control._beginPick('end');
        control._box.querySelector('#wnav-pick-end').classList.add('is-next');
        control._setStatus('Точка A установлена. Теперь выберите точку B на карте.');
      } else {
        control._endPick();
        control._box.querySelector('#wnav-pick-end').classList.remove('is-next');
      }
      return true;
    }

    console.info('[Winterhold Navigator V2] Graph ready', {
      roads: new Set(graph.edges.map(e => e.roadId)).size,
      edges: graph.edges.length,
      nodes: graph.nodes.size,
      components: graph.componentCount
    });

    return {
      graph,
      handleMapClick,
      reset: () => control._reset(),
      buildRoute: () => control._build(),
      config: CONFIG
    };
  }

  root.WinterholdRoadNavigator = { CONFIG, buildGraph, nearestRoadSnap, findRoute, buildInstructions, attach };
})(typeof window !== 'undefined' ? window : globalThis);
