/* Winterhold Road Admin Editor V1
 * Admin-only vector road creation on the Leaflet map.
 * Roads are stored as append-only events in Firebase RTDB under road_network_additions/events.
 * If RTDB rules deny writes, the event remains in this browser and can be exported as JSON.
 */
(function (root) {
  'use strict';

  const LOCAL_KEY = 'winterhold_road_admin_local_v1';
  const SNAP_PX = 24;
  const ROUTE_BOUNDS = { minX: 288, maxX: 4000, minY: -3440, maxY: -320 };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
  function inBounds(p) { return p[0] >= ROUTE_BOUNDS.minX && p[0] <= ROUTE_BOUNDS.maxX && p[1] >= ROUTE_BOUNDS.minY && p[1] <= ROUTE_BOUNDS.maxY; }

  function catmullRom(points, steps) {
    if (points.length < 2) return points.map(p => p.slice());
    const out = [];
    const n = Math.max(4, steps || 8);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0]) * t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0]) * t3);
        const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1]) * t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1]) * t3);
        out.push([x, y]);
      }
    }
    out.push(points[points.length - 1].slice());
    return out;
  }

  function projectPoint(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx*dx + dy*dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy)/l2)) : 0;
    const q = [a[0] + dx*t, a[1] + dy*t];
    return { point:q, t, distance:dist(p,q) };
  }

  function nearestRoad(p, features, maxDistance) {
    let best = null;
    (features || []).forEach(feature => {
      const coords = feature && feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      for (let i = 0; i < coords.length - 1; i++) {
        const hit = projectPoint(p, coords[i], coords[i+1]);
        if (!best || hit.distance < best.distance) {
          best = { roadId:String((feature.properties || {}).id || feature.id || ''), segmentIndex:i, t:hit.t, x:hit.point[0], y:hit.point[1], distance:hit.distance };
        }
      }
    });
    return best && best.distance <= maxDistance ? best : null;
  }

  function nearestRoadHits(p, features, maxDistance) {
    const hits = [];
    (features || []).forEach(feature => {
      const props = feature && feature.properties || {};
      if (String(props.status || '').toLowerCase() === 'rejected') return;
      const coords = feature && feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      let best = null;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const hit = projectPoint(p, a, b);
        if (!best || hit.distance < best.distance) {
          best = {
            roadId: String(props.id || feature.id || ''),
            segmentIndex: i,
            t: hit.t,
            x: hit.point[0],
            y: hit.point[1],
            distance: hit.distance
          };
        }
      }
      if (best && best.roadId && best.distance <= maxDistance) hits.push(best);
    });
    return hits.sort((a, b) => a.distance - b.distance);
  }

  function segmentIntersection(a, b, c, d) {
    const r = [b[0]-a[0], b[1]-a[1]], s = [d[0]-c[0], d[1]-c[1]];
    const den = cross(r[0], r[1], s[0], s[1]);
    if (Math.abs(den) < 1e-8) return null;
    const ca = [c[0]-a[0], c[1]-a[1]];
    const t = cross(ca[0], ca[1], s[0], s[1]) / den;
    const u = cross(ca[0], ca[1], r[0], r[1]) / den;
    if (t < -1e-6 || t > 1+1e-6 || u < -1e-6 || u > 1+1e-6) return null;
    return { t:Math.max(0,Math.min(1,t)), u:Math.max(0,Math.min(1,u)), point:[a[0]+r[0]*t, a[1]+r[1]*t] };
  }

  function applyBindings(feature, bindings) {
    if (!bindings || !bindings.length) return feature;
    const oldCoords = feature.geometry.coordinates;
    const inserts = new Map();
    const pointRefs = new Map();
    bindings.forEach(b => {
      if (Number.isInteger(b.pointIndex)) {
        const list = pointRefs.get(b.pointIndex) || [];
        list.push(b.junctionId); pointRefs.set(b.pointIndex, list);
      } else if (Number.isInteger(b.segmentIndex) && Number.isFinite(b.t)) {
        if (b.t <= 1e-5) {
          const list = pointRefs.get(b.segmentIndex) || []; list.push(b.junctionId); pointRefs.set(b.segmentIndex, list);
        } else if (b.t >= 1 - 1e-5) {
          const idx = b.segmentIndex + 1; const list = pointRefs.get(idx) || []; list.push(b.junctionId); pointRefs.set(idx, list);
        } else {
          const list = inserts.get(b.segmentIndex) || [];
          list.push({ t:b.t, x:b.x, y:b.y, junctionId:b.junctionId }); inserts.set(b.segmentIndex, list);
        }
      }
    });

    const nextCoords = [], oldToNew = new Map(), newRefs = [];
    for (let i = 0; i < oldCoords.length; i++) {
      oldToNew.set(i, nextCoords.length);
      nextCoords.push(oldCoords[i].slice());
      (pointRefs.get(i) || []).forEach(jid => newRefs.push({ point_index:oldToNew.get(i), junction_id:jid }));
      const list = (inserts.get(i) || []).sort((a,b) => a.t - b.t);
      list.forEach(it => {
        nextCoords.push([it.x, it.y]);
        newRefs.push({ point_index:nextCoords.length - 1, junction_id:it.junctionId });
      });
    }
    const props = feature.properties || (feature.properties = {});
    const refs = (props.junction_refs || []).map(ref => ({ point_index:oldToNew.get(ref.point_index) ?? ref.point_index, junction_id:ref.junction_id || ref.junctionId }));
    const mergedRefs = new Map();
    refs.concat(newRefs).forEach(ref => {
      if (ref.junction_id == null || !Number.isInteger(ref.point_index)) return;
      mergedRefs.set(ref.point_index + '|' + ref.junction_id, ref);
    });
    feature.geometry.coordinates = nextCoords;
    props.junction_refs = Array.from(mergedRefs.values()).sort((a,b) => a.point_index - b.point_index);
    return feature;
  }

  function attach(map, L, database, navigator, getUser, baseNetwork, baseTopology) {
    const baseN = clone(baseNetwork);
    const baseT = clone(baseTopology);
    let remoteEvents = [];
    let localEvents = readLocalEvents();
    let mergedNetwork = clone(baseN);
    let mergedTopology = clone(baseT);
    let drawing = false;
    let nodeMode = false;
    let nodeSaveBusy = false;
    let nodePreview = null;
    let controlPoints = [];
    let previewLine = null;
    let previewCasing = null;
    let previewDots = [];
    let showLayer = false;
    let dbReadError = '';
    const adminLayers = L.layerGroup();
    let roadCounter = 1;
    const rootEl = document.createElement('div');

    function readLocalEvents() {
      try { const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(v) ? v : []; }
      catch (_) { return []; }
    }
    function writeLocalEvents() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(localEvents)); } catch (_) {} }
    function isAdmin() { const u = typeof getUser === 'function' ? getUser() : null; return !!(u && String(u.role).toLowerCase() === 'admin'); }
    function author() { const u = typeof getUser === 'function' ? getUser() : null; return u && u.name ? String(u.name) : 'Администратор'; }
    function allEvents() {
      const byId = new Map();
      remoteEvents.forEach(e => { if (e && e.id) byId.set(e.id, e); });
      if (isAdmin()) localEvents.forEach(e => { if (e && e.id && !byId.has(e.id)) byId.set(e.id, e); });
      return Array.from(byId.values()).sort((a,b) => Number(a.createdAt||0)-Number(b.createdAt||0));
    }

    function rebuildMerged() {
      const features = baseN.features.map(clone);
      const junctions = (baseT.junctions || []).map(clone);
      const junctionMap = new Map(junctions.map(j => [j.id,j]));
      allEvents().forEach(event => {
        const byRoad = new Map();
        (event.bindings || []).forEach(binding => {
          const list = byRoad.get(binding.roadId) || []; list.push(binding); byRoad.set(binding.roadId,list);
        });
        byRoad.forEach((bindings, roadId) => {
          const target = features.find(f => String((f.properties||{}).id || f.id) === String(roadId));
          if (target) applyBindings(target, bindings);
        });
        (event.junctions || []).forEach(j => {
          if (!junctionMap.has(j.id)) { const copy = clone(j); junctions.push(copy); junctionMap.set(copy.id,copy); }
        });
        (event.junctionUpdates || []).forEach(update => {
          const j = junctionMap.get(update.id);
          if (j) {
            const ids = new Set([...(j.connectedRoadIds || []), ...(update.connectedRoadIds || [])]);
            j.connectedRoadIds = Array.from(ids); j.degree = j.connectedRoadIds.length;
          }
        });
        if (event.feature && event.feature.geometry && event.feature.geometry.type === 'LineString') features.push(clone(event.feature));
      });
      mergedNetwork = Object.assign({}, clone(baseN), { features });
      mergedTopology = Object.assign({}, clone(baseT), { junctions });
      if (navigator && typeof navigator.setNetwork === 'function') navigator.setNetwork(mergedNetwork, mergedTopology);
      if (showLayer && isAdmin()) renderAdminLayer();
      updateStatus();
    }

    function currentSnapLimit() { const scale = Math.pow(2, map.getZoom()) / 16; return SNAP_PX / Math.max(scale, 0.0001); }

    function makeJunction(point, roadA, roadB, localJunctions, updates, preferredId) {
      const near = (mergedTopology.junctions || []).find(j => Math.hypot(Number(j.lng)-point[0], Number(j.lat)-point[1]) <= 3.2);
      const localNear = localJunctions.find(j => Math.hypot(Number(j.lng)-point[0], Number(j.lat)-point[1]) <= 2.2);
      const existing = near || localNear;
      if (existing) {
        const ids = new Set(existing.connectedRoadIds || []); ids.add(roadA); if (roadB) ids.add(roadB);
        updates.push({ id:existing.id, connectedRoadIds:Array.from(ids) });
        return existing.id;
      }
      const id = preferredId || uid('junction-admin');
      const ids = Array.from(new Set([roadA, roadB].filter(Boolean)));
      localJunctions.push({ id, name:'Соединение администратора', lng:point[0], lat:point[1], degree:ids.length, connectedRoadIds:ids });
      return id;
    }

    function addBinding(bindings, snap, junctionId) {
      if (!snap) return;
      bindings.push({
        roadId:snap.roadId,
        segmentIndex:snap.segmentIndex,
        t:snap.t,
        x:snap.x, y:snap.y,
        junctionId
      });
    }

    async function createJunctionAt(point) {
      if (!isAdmin() || nodeSaveBusy) return;
      if (!inBounds(point)) {
        status('Эта область находится за рабочими границами карты.','is-warning');
        return;
      }
      nodeSaveBusy = true;
      try {
        const maxDistance = currentSnapLimit() * 1.25;
        const hits = nearestRoadHits(point, mergedNetwork.features || [], maxDistance);
        if (!hits.length) {
          status('Рядом нет дороги. Приблизьте перекрёсток и поставьте узел ближе к линиям.','is-warning');
          return;
        }

        // Prefer an existing nearby junction so a new branch can join an existing node.
        const avgPoint = [
          hits.reduce((sum, hit) => sum + hit.x, 0) / hits.length,
          hits.reduce((sum, hit) => sum + hit.y, 0) / hits.length
        ];
        const existing = (mergedTopology.junctions || []).find(j =>
          Math.hypot(Number(j.lng) - avgPoint[0], Number(j.lat) - avgPoint[1]) <= Math.min(7.5, currentSnapLimit() * 0.34)
        );
        const junctionId = existing ? existing.id : uid('junction-admin');
        const sharedPoint = existing ? [Number(existing.lng), Number(existing.lat)] : avgPoint;
        const alreadyBoundRoads = new Set();
        (mergedNetwork.features || []).forEach(feature => {
          const props = feature.properties || {};
          if ((props.junction_refs || props.junctionRefs || []).some(ref => (ref.junction_id || ref.junctionId) === junctionId)) {
            alreadyBoundRoads.add(String(props.id || feature.id || ''));
          }
        });
        const attachHits = hits.filter(hit => !alreadyBoundRoads.has(hit.roadId));
        if (!attachHits.length) {
          status('Эти дороги уже подключены к выбранному узлу.','is-good');
          return;
        }

        const connectedRoadIds = Array.from(new Set([
          ...((existing && existing.connectedRoadIds) || []),
          ...attachHits.map(hit => hit.roadId)
        ]));
        const event = {
          schema: 'winterhold-road-addition-event-v1',
          type: 'junction-addition',
          id: uid('junction-event'),
          createdAt: Date.now(),
          createdBy: author(),
          junctions: existing ? [] : [{
            id: junctionId,
            name: 'Соединение администратора',
            lng: sharedPoint[0],
            lat: sharedPoint[1],
            degree: connectedRoadIds.length,
            connectedRoadIds
          }],
          junctionUpdates: existing ? [{ id: junctionId, connectedRoadIds }] : [],
          bindings: attachHits.map(hit => ({
            roadId: hit.roadId,
            segmentIndex: hit.segmentIndex,
            t: hit.t,
            x: sharedPoint[0],
            y: sharedPoint[1],
            junctionId
          }))
        };

        try {
          await database.ref('road_network_additions/events/' + event.id).set(event);
          status('Соединительный узел создан. Подключено дорог: ' + attachHits.length + '. Можно поставить следующий.','is-good');
        } catch (writeErr) {
          localEvents.push(event);
          writeLocalEvents();
          status('Firebase запретил запись. Узел сохранён только в этом браузере — скачайте резервную копию.','is-warning');
          console.warn('[Road Admin] Junction write denied; stored locally.', writeErr);
        }
        rebuildMerged();
      } catch (err) {
        status(err && err.message ? err.message : 'Не удалось создать соединительный узел.','is-warning');
      } finally {
        nodeSaveBusy = false;
      }
    }

    function startNodeMode() {
      if (!isAdmin()) return;
      if (drawing) cancelDrawing(true);
      if (navigator && typeof navigator.reset === 'function') navigator.reset();
      nodeMode = true;
      showLayer = true;
      rootEl.classList.remove('is-collapsed');
      rootEl.classList.add('is-node-mode');
      rootEl.querySelector('#road-admin-start').classList.remove('is-active');
      rootEl.querySelector('#road-admin-node-start').classList.add('is-active');
      rootEl.querySelector('#road-admin-node-actions').style.display = 'grid';
      rootEl.querySelector('#road-admin-draw-actions').style.display = 'none';
      rootEl.querySelector('#road-admin-start').style.display = '';
      rootEl.querySelector('#road-admin-node-start').style.display = '';
      rootEl.querySelector('#road-admin-toggle').textContent = 'Скрыть дороги';
      map.getContainer().style.cursor = 'crosshair';
      renderAdminLayer();
      status('Режим узлов: кликните по пересечению или месту подключения дороги.','is-good');
    }

    function clearNodePreview() {
      if (nodePreview && map.hasLayer(nodePreview)) map.removeLayer(nodePreview);
      nodePreview = null;
    }

    function updateNodePreview(e) {
      if (!nodeMode || !isAdmin()) return;
      const p = [Number(e.latlng.lng), Number(e.latlng.lat)];
      const hit = nearestRoad(p, mergedNetwork.features || [], currentSnapLimit() * 1.25);
      const latlng = hit ? [hit.y, hit.x] : [p[1], p[0]];
      if (!nodePreview) {
        nodePreview = L.circleMarker(latlng, {
          radius: 9, color: '#fff4c2', weight: 2.5,
          fillColor: hit ? '#ffd34d' : '#e43c4b', fillOpacity: 0.95,
          opacity: 1, interactive: false, className: 'road-admin-node-preview'
        }).addTo(map);
      } else {
        nodePreview.setLatLng(latlng);
        nodePreview.setStyle({ fillColor: hit ? '#ffd34d' : '#e43c4b' });
      }
    }

    function cancelNodeMode(silent) {
      nodeMode = false;
      rootEl.classList.remove('is-node-mode');
      rootEl.querySelector('#road-admin-node-start').classList.remove('is-active');
      rootEl.querySelector('#road-admin-node-actions').style.display = 'none';
      clearNodePreview();
      map.getContainer().style.cursor = '';
      renderAdminLayer();
      if (!silent) status('Режим узлов завершён.');
    }

    function buildRoadEvent() {
      const name = (rootEl.querySelector('#road-admin-name').value || '').trim() || ('Новая дорога ' + String(roadCounter++).padStart(3,'0'));
      const kind = rootEl.querySelector('#road-admin-kind').value === 'main' ? 'main' : 'secondary';
      const points = catmullRom(controlPoints, 9);
      if (points.length < 2) throw new Error('Поставьте минимум две точки.');
      const features = mergedNetwork.features || [];
      const roadId = uid('road-admin');
      const createdJunctions = [], junctionUpdates = [], bindings = [];
      const pathInsertions = [];
      const connectedRoads = new Set();
      const maxSnap = currentSnapLimit();
      const endpointJunctions = new Map();

      // Snap both ends to a nearby existing road, when possible.
      [[0,'start'], [points.length-1,'end']].forEach(pair => {
        const idx = pair[0];
        const snap = nearestRoad(points[idx], features, maxSnap);
        if (!snap) return;
        points[idx] = [snap.x, snap.y];
        const jid = makeJunction(points[idx], roadId, snap.roadId, createdJunctions, junctionUpdates);
        endpointJunctions.set(idx, jid);
        addBinding(bindings, snap, jid);
        connectedRoads.add(snap.roadId);
      });

      // Detect real crossings along the drawn road and create a shared graph node.
      let walkedNew = 0;
      const cumulative = [0];
      for (let i=1;i<points.length;i++) cumulative.push(cumulative[i-1] + dist(points[i-1],points[i]));
      const hitBuckets = [];
      features.forEach(feature => {
        const coords = feature.geometry && feature.geometry.coordinates;
        const oldRoadId = String((feature.properties||{}).id || feature.id || '');
        if (!Array.isArray(coords) || coords.length < 2 || !oldRoadId) return;
        for (let i=0;i<points.length-1;i++) {
          const a=points[i], b=points[i+1];
          for (let j=0;j<coords.length-1;j++) {
            const hit=segmentIntersection(a,b,coords[j],coords[j+1]);
            if (!hit) continue;
            // Endpoints are handled by endpoint snapping; avoid duplicate near-end anchors.
            if ((i===0 && hit.t<0.012) || (i===points.length-2 && hit.t>0.988)) continue;
            if (hit.t<0.001 || hit.t>0.999 || hit.u<0.001 || hit.u>0.999) continue;
            const duplicate=hitBuckets.find(h => h.roadId===oldRoadId && dist(h.point,hit.point)<1.1);
            if (duplicate) continue;
            hitBuckets.push({ roadId:oldRoadId, segmentIndex:j, t:hit.u, newSegmentIndex:i, newT:hit.t, point:hit.point });
          }
        }
      });

      const pathRefRecords=[];
      hitBuckets.forEach(hit => {
        const jid=makeJunction(hit.point,roadId,hit.roadId,createdJunctions,junctionUpdates);
        addBinding(bindings,{roadId:hit.roadId,segmentIndex:hit.segmentIndex,t:hit.t,x:hit.point[0],y:hit.point[1]},jid);
        pathRefRecords.push({segmentIndex:hit.newSegmentIndex,t:hit.newT,junctionId:jid,point:hit.point});
        connectedRoads.add(hit.roadId);
      });

      // Create refs for endpoint snaps and insert crossing points into the new geometry.
      const refs=[];
      endpointJunctions.forEach((jid, index) => refs.push({point_index:index===0?0:-1,junction_id:jid}));
      const insertsBySegment=new Map();
      pathRefRecords.forEach(r => { const a=insertsBySegment.get(r.segmentIndex)||[];a.push(r);insertsBySegment.set(r.segmentIndex,a); });
      const finalCoords=[];
      for (let i=0;i<points.length;i++) {
        finalCoords.push(points[i].slice());
        if (i===points.length-1 && endpointJunctions.has(i)) refs.push({point_index:finalCoords.length-1,junction_id:endpointJunctions.get(i)});
        const list=(insertsBySegment.get(i)||[]).sort((a,b)=>a.t-b.t);
        list.forEach(r=>{
          finalCoords.push(r.point.slice());
          refs.push({point_index:finalCoords.length-1,junction_id:r.junctionId});
        });
      }
      // Rebuild start ref after final coordinates are known.
      refs.forEach(ref => { if (ref.point_index === -1) ref.point_index=finalCoords.length-1; });
      const uniqRefs=new Map(); refs.forEach(r=>uniqRefs.set(r.point_index+'|'+r.junction_id,r));
      const junctionRefs=Array.from(uniqRefs.values()).sort((a,b)=>a.point_index-b.point_index);

      if (!junctionRefs.length) throw new Error('Дорога не подключилась к существующей сети. Начните или закончите её рядом с другой дорогой либо пересеките существующую дорогу.');
      const createdAt=Date.now();
      const feature={
        type:'Feature', id:roadId,
        properties:{ id:roadId, name, kind, status:'verified', sourceTier:'admin_added', createdAt, createdBy:author(), editor:'Atlas Road Admin', junction_refs:junctionRefs, note:'Добавлена администратором на основной карте' },
        geometry:{ type:'LineString', coordinates:finalCoords }
      };
      // Refresh connected-road metadata on new junctions.
      createdJunctions.forEach(j=>{ const ids=new Set([...(j.connectedRoadIds||[]),roadId]); j.connectedRoadIds=Array.from(ids); j.degree=j.connectedRoadIds.length; });
      return { schema:'winterhold-road-addition-event-v1', id:roadId, createdAt, createdBy:author(), feature, junctions:createdJunctions, junctionUpdates, bindings };
    }

    // Admin edit mode uses a high-contrast red network, deliberately distinct
    // from the permanent beige roads baked into the map tiles and the violet route.
    function renderAdminLayer() {
      adminLayers.clearLayers();
      (mergedNetwork.features || []).forEach(feature => {
        const coords=feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length<2) return;
        const props=feature.properties||{};
        const isMain=props.kind==='main';
        const isAdded=props.sourceTier==='admin_added';
        const latlngs=coords.map(c=>[c[1],c[0]]);
        const coreWeight=isMain?4.8:3.8;
        L.polyline(latlngs,{
          color:'#350b12', weight:coreWeight+4.4, opacity:.96,
          lineCap:'round',lineJoin:'round',interactive:false,
          className:'road-admin-red-casing'
        }).addTo(adminLayers);
        L.polyline(latlngs,{
          color:isAdded?'#ff493f':'#ed2638', weight:coreWeight, opacity:1,
          lineCap:'round',lineJoin:'round',dashArray:null,interactive:false,
          className:'road-admin-red-core'
        }).addTo(adminLayers);
      });
      if (nodeMode) {
        (mergedTopology.junctions || []).forEach(j => {
          L.circleMarker([Number(j.lat), Number(j.lng)], {
            radius: 6.5, color: '#24151a', weight: 2.2,
            fillColor: '#ffd34d', fillOpacity: 1, opacity: 1,
            interactive: false, className: 'road-admin-junction-marker'
          }).addTo(adminLayers);
        });
      }
      if (showLayer && isAdmin()) adminLayers.addTo(map);
      else if (map.hasLayer(adminLayers)) map.removeLayer(adminLayers);
    }

    function renderPreview() {
      if (previewCasing && map.hasLayer(previewCasing)) map.removeLayer(previewCasing);
      if (previewLine && map.hasLayer(previewLine)) map.removeLayer(previewLine);
      previewDots.forEach(m=>{if(map.hasLayer(m))map.removeLayer(m);}); previewDots=[];
      if (controlPoints.length>=2) {
        const curve=catmullRom(controlPoints,9).map(p=>[p[1],p[0]]);
        previewCasing=L.polyline(curve,{color:'#350b12',weight:10,opacity:.96,lineCap:'round',lineJoin:'round',interactive:false}).addTo(map);
        previewLine=L.polyline(curve,{color:'#ff3b45',weight:5.2,opacity:1,dashArray:'9 5',lineCap:'round',lineJoin:'round',interactive:false}).addTo(map);
      }
      controlPoints.forEach((p,i)=>{
        const m=L.circleMarker([p[1],p[0]],{radius:6,color:'#fff0e8',weight:2,fillColor:'#f02d3a',fillOpacity:1,interactive:false}).addTo(map);
        previewDots.push(m);
      });
    }

    function clearPreview() {
      if (previewCasing && map.hasLayer(previewCasing)) map.removeLayer(previewCasing);
      if (previewLine && map.hasLayer(previewLine)) map.removeLayer(previewLine);
      previewCasing=null; previewLine=null;
      previewDots.forEach(m=>{if(map.hasLayer(m))map.removeLayer(m);}); previewDots=[];
    }

    function status(text, tone) {
      const el=rootEl.querySelector('#road-admin-status');
      if(el){el.textContent=text;el.className='road-admin-status'+(tone?' '+tone:'');}
    }
    function updateStatus() {
      const roadsEl = rootEl.querySelector('#road-admin-road-count');
      const nodesEl = rootEl.querySelector('#road-admin-node-count');
      if (roadsEl) roadsEl.textContent = (mergedNetwork.features || []).filter(f => f.geometry && f.geometry.type === 'LineString').length;
      if (nodesEl) nodesEl.textContent = (mergedTopology.junctions || []).length;
    }

    function downloadJson(filename, data) {
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
    }

    function exportBackup() {
      downloadJson('ROAD_NETWORK_ADMIN_ADDITIONS.json',{schema:'winterhold-road-additions-backup-v1',exportedAt:new Date().toISOString(),events:allEvents()});
      status('Резервная копия скачана.','is-good');
    }

    function startDrawing() {
      if(!isAdmin()) return;
      if (nodeMode) cancelNodeMode(true);
      if(navigator && typeof navigator.reset==='function') navigator.reset();
      rootEl.classList.remove('is-collapsed');
      showLayer = true;
      rootEl.querySelector('#road-admin-toggle').textContent = 'Скрыть дороги';
      renderAdminLayer();
      drawing=true;controlPoints=[];clearPreview();map.doubleClickZoom.disable();map.getContainer().style.cursor='crosshair';
      rootEl.classList.add('is-drawing');
      rootEl.querySelector('#road-admin-start').classList.add('is-active');
      rootEl.querySelector('#road-admin-node-start').classList.remove('is-active');
      rootEl.querySelector('#road-admin-start').style.display='none';
      rootEl.querySelector('#road-admin-node-start').style.display='none';
      rootEl.querySelector('#road-admin-draw-actions').style.display='grid';
      rootEl.querySelector('#road-admin-node-actions').style.display='none';
      status('Рисование дороги: кликайте по карте, добавляя точки изгиба.','is-good');
    }

    function cancelDrawing(silent) {
      drawing=false;controlPoints=[];clearPreview();map.doubleClickZoom.enable();
      if (!nodeMode) map.getContainer().style.cursor='';
      rootEl.classList.remove('is-drawing');
      rootEl.querySelector('#road-admin-start').classList.remove('is-active');
      rootEl.querySelector('#road-admin-start').style.display='';
      rootEl.querySelector('#road-admin-node-start').style.display='';
      rootEl.querySelector('#road-admin-draw-actions').style.display='none';
      if (!silent) status('Рисование отменено.');
    }

    async function finishDrawing() {
      if(!isAdmin()) { cancelDrawing(); return; }
      if(controlPoints.length<2){status('Добавьте хотя бы две точки.','is-warning');return;}
      const finishBtn=rootEl.querySelector('#road-admin-finish');finishBtn.disabled=true;
      try {
        const event=buildRoadEvent();
        const ref=database.ref('road_network_additions/events/'+event.id);
        try {
          await ref.set(event);
          status('Дорога сохранена в архиве и подключена к навигатору.','is-good');
        } catch (writeErr) {
          localEvents.push(event);writeLocalEvents();rebuildMerged();
          status('Firebase запретил запись. Дорога сохранена только в этом браузере — скачайте резервную копию.','is-warning');
          console.warn('[Road Admin] Firebase write denied; stored locally.',writeErr);
        }
        cancelDrawing(true);
        if(!rootEl.querySelector('#road-admin-name').value.trim()) rootEl.querySelector('#road-admin-name').value='';
        if (rootEl.querySelector('#road-admin-kind').value==='') rootEl.querySelector('#road-admin-kind').value='secondary';
        status('Дорога сохранена и добавлена в граф маршрутизации.','is-good');
      } catch(err) {
        status(err && err.message ? err.message : 'Не удалось создать дорогу.','is-warning');
      } finally { finishBtn.disabled=false; }
    }

    function undoPoint() {
      if(!drawing || !controlPoints.length) return;
      controlPoints.pop();renderPreview();status('Точка удалена. Осталось точек: '+controlPoints.length);
    }

    function setPermission() {
      const admin=isAdmin();
      rootEl.style.display=admin?'block':'none';
      if(!admin){
        if(drawing)cancelDrawing(true);
        if(nodeMode)cancelNodeMode(true);
        if(map.hasLayer(adminLayers))map.removeLayer(adminLayers);
        showLayer=false;
      }
    }

    rootEl.className='road-admin-control is-collapsed';
    rootEl.innerHTML=`
      <div class="road-admin-card">
        <div class="road-admin-head">
          <span class="road-admin-emblem">ᚱ</span>
          <div class="road-admin-title"><b>РЕДАКТОР ДОРОГ</b><small>Инструменты администрации</small></div>
          <span class="road-admin-head-count" id="road-admin-head-count">Сеть</span>
          <button type="button" id="road-admin-collapse" title="Открыть / свернуть редактор" aria-label="Открыть или свернуть редактор">⌃</button>
        </div>
        <div class="road-admin-body" id="road-admin-body">
          <div class="road-admin-metrics">
            <span><b id="road-admin-road-count">122</b><small>дорог</small></span>
            <span><b id="road-admin-node-count">128</b><small>узлов</small></span>
          </div>
          <div class="road-admin-section-title">ИНСТРУМЕНТЫ</div>
          <div class="road-admin-mode-grid">
            <button type="button" class="road-admin-mode road-admin-primary" id="road-admin-start">＋ Дорога</button>
            <button type="button" class="road-admin-mode road-admin-node-button" id="road-admin-node-start">◎ Узел</button>
          </div>
          <label class="road-admin-label">Название дороги<input id="road-admin-name" type="text" maxlength="70" placeholder="Например, Тропа к Винтерхолду"></label>
          <label class="road-admin-label">Тип дороги<select id="road-admin-kind"><option value="main">Главная дорога</option><option value="secondary" selected>Второстепенная дорога</option></select></label>
          <div class="road-admin-draw-actions" id="road-admin-draw-actions" style="display:none">
            <div class="road-admin-hint">Кликайте по карте, добавляя изгибы. Концы и реальные пересечения автоматически подключаются к сети.</div>
            <div class="road-admin-action-grid"><button type="button" id="road-admin-undo">↶ Отменить точку</button><button type="button" id="road-admin-cancel">Отмена</button></div>
            <button type="button" class="road-admin-primary" id="road-admin-finish">Завершить и сохранить дорогу</button>
          </div>
          <div class="road-admin-node-actions" id="road-admin-node-actions" style="display:none">
            <div class="road-admin-hint road-admin-node-hint">Кликните в центр перекрёстка. Все близкие дороги получат один общий соединительный узел.</div>
            <button type="button" id="road-admin-node-cancel">Завершить создание узлов</button>
          </div>
          <div class="road-admin-status" id="road-admin-status">Редактор свёрнут. Откройте панель, чтобы добавлять дороги и узлы.</div>
          <div class="road-admin-tools"><button type="button" id="road-admin-toggle">Показать дороги</button><button type="button" id="road-admin-export">Резервная копия</button></div>
        </div>
      </div>`;
    document.body.appendChild(rootEl);

    // A compact floating style replaces the previous always-open admin card.
    const adminStyle = document.createElement('style');
    adminStyle.id = 'winterhold-road-admin-editor-v3-3-style';
    adminStyle.textContent = `
      .road-admin-control{position:fixed!important;left:78px!important;bottom:76px!important;z-index:1800!important;width:292px!important;max-width:calc(100vw - 96px)!important;font-family:Georgia,serif!important;color:#e8dfcc!important;}
      .road-admin-card{border:1px solid rgba(197,163,101,.72)!important;border-radius:12px!important;background:linear-gradient(150deg,rgba(25,39,47,.98),rgba(15,25,32,.97))!important;box-shadow:0 10px 30px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.06)!important;overflow:hidden!important;backdrop-filter:blur(12px)!important;}
      .road-admin-head{display:flex!important;align-items:center!important;gap:9px!important;padding:9px 11px!important;border-bottom:1px solid rgba(197,163,101,.22)!important;min-height:42px!important;}
      .road-admin-emblem{width:29px!important;height:29px!important;display:grid!important;place-items:center!important;border:1px solid rgba(210,176,111,.62)!important;border-radius:9px!important;color:#dfbd7e!important;font-size:18px!important;flex:none!important;}
      .road-admin-title{min-width:0!important;display:flex!important;flex-direction:column!important;gap:2px!important;}
      .road-admin-head b{display:block!important;color:#f1d7a6!important;font-size:10px!important;letter-spacing:.09em!important;}
      .road-admin-head small{display:block!important;color:#bdb6a7!important;font-size:9px!important;margin-top:1px!important;}
      .road-admin-head-count{margin-left:auto!important;color:#ffb1a9!important;font:700 9px Arial,sans-serif!important;white-space:nowrap!important;}
      .road-admin-head button{width:27px!important;height:27px!important;color:#ead9b7!important;background:rgba(255,255,255,.06)!important;border:1px solid rgba(204,173,118,.3)!important;border-radius:7px!important;cursor:pointer!important;flex:none!important;margin:0!important;}
      .road-admin-control.is-collapsed{width:238px!important;}
      .road-admin-control.is-collapsed .road-admin-head{border-bottom:0!important;}
      .road-admin-control.is-collapsed .road-admin-head button{transform:rotate(180deg);}
      .road-admin-control.is-collapsed .road-admin-body{display:none!important;}
      .road-admin-body{padding:10px 11px 11px!important;display:grid!important;gap:8px!important;}
      .road-admin-metrics{display:grid!important;grid-template-columns:1fr 1fr!important;gap:7px!important;}
      .road-admin-metrics span{display:flex!important;align-items:baseline!important;gap:5px!important;padding:7px 9px!important;background:rgba(255,255,255,.045)!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:7px!important;}
      .road-admin-metrics b{font:700 15px Arial,sans-serif!important;color:#ff7777!important;}
      .road-admin-metrics small{font:10px Arial,sans-serif!important;color:#c4c0b5!important;}
      .road-admin-section-title{font:700 9px Arial,sans-serif!important;letter-spacing:.14em!important;color:#bda77e!important;margin-top:1px!important;}
      .road-admin-mode-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:7px!important;}
      .road-admin-control button{cursor:pointer!important;transition:filter .15s ease,transform .15s ease!important;}
      .road-admin-control button:hover{filter:brightness(1.12)!important;}
      .road-admin-control button:active{transform:translateY(1px)!important;}
      .road-admin-mode{min-height:37px!important;border-radius:7px!important;font:700 11px Georgia,serif!important;}
      .road-admin-primary{background:linear-gradient(180deg,#b83b43,#84232e)!important;border:1px solid rgba(255,143,143,.68)!important;color:#fff8e8!important;border-radius:7px!important;padding:8px 10px!important;font:bold 11px Georgia,serif!important;}
      .road-admin-node-button{background:linear-gradient(180deg,rgba(116,85,40,.95),rgba(75,55,29,.97))!important;border:1px solid rgba(238,196,105,.66)!important;color:#ffe5a4!important;}
      .road-admin-mode.is-active{box-shadow:0 0 0 2px rgba(255,220,130,.22),0 0 16px rgba(235,55,65,.23)!important;border-color:#ffe8b5!important;}
      .road-admin-label{display:grid!important;gap:4px!important;color:#c9b998!important;font:10px Arial,sans-serif!important;}
      .road-admin-label input,.road-admin-label select{width:100%!important;box-sizing:border-box!important;background:rgba(12,20,25,.82)!important;border:1px solid rgba(191,160,103,.42)!important;border-radius:6px!important;padding:7px 8px!important;color:#f0e8d7!important;font:12px Georgia,serif!important;outline:none!important;}
      .road-admin-label input:focus,.road-admin-label select:focus{border-color:#e76a70!important;box-shadow:0 0 0 2px rgba(230,65,75,.14)!important;}
      .road-admin-draw-actions,.road-admin-node-actions{display:grid!important;gap:7px!important;}
      .road-admin-action-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:7px!important;}
      .road-admin-tools{display:grid!important;grid-template-columns:1fr 1fr!important;gap:7px!important;}
      .road-admin-tools button,.road-admin-action-grid button,.road-admin-node-actions>button{padding:7px 8px!important;background:rgba(255,255,255,.055)!important;color:#e6dcc8!important;border:1px solid rgba(193,165,112,.35)!important;border-radius:6px!important;font:10px Arial,sans-serif!important;}
      .road-admin-primary:disabled{opacity:.5!important;cursor:wait!important;}
      .road-admin-hint{font:10px/1.4 Arial,sans-serif!important;color:#f0ddd0!important;background:rgba(211,55,68,.10)!important;border:1px solid rgba(227,83,91,.30)!important;padding:8px!important;border-radius:7px!important;}
      .road-admin-node-hint{background:rgba(237,183,74,.09)!important;border-color:rgba(237,183,74,.33)!important;color:#f4e7c8!important;}
      .road-admin-status{font:10px/1.4 Arial,sans-serif!important;color:#c6c1b5!important;background:rgba(255,255,255,.035)!important;border:1px solid rgba(255,255,255,.08)!important;padding:7px 8px!important;border-radius:7px!important;}
      .road-admin-status.is-good{color:#b5e4d9!important;border-color:rgba(91,209,194,.28)!important;background:rgba(91,209,194,.08)!important;}
      .road-admin-status.is-warning{color:#f0c99b!important;border-color:rgba(226,163,92,.32)!important;background:rgba(226,163,92,.08)!important;}
      .road-admin-control.is-drawing .road-admin-card,.road-admin-control.is-node-mode .road-admin-card{border-color:rgba(255,107,107,.85)!important;}
      .road-admin-control.is-drawing .road-admin-emblem,.road-admin-control.is-node-mode .road-admin-emblem{color:#ff8a8a!important;border-color:#ef5964!important;}
      .road-admin-junction-marker{filter:drop-shadow(0 0 4px rgba(255,211,77,.8));}
      .road-admin-node-preview{filter:drop-shadow(0 0 7px rgba(255,211,77,.9));}
      body:not(.is-admin) .road-admin-control{display:none!important;}
      .winterhold-navigator-control{width:252px!important;max-width:calc(100vw - 86px)!important;}
      @media(max-width:700px){.road-admin-control{left:70px!important;bottom:78px!important;width:276px!important;max-width:calc(100vw - 82px)!important;}.road-admin-control.is-collapsed{width:220px!important;}.road-admin-head{padding:8px 9px!important}.road-admin-body{padding:8px 9px!important;gap:7px!important}.winterhold-navigator-control{width:244px!important;max-width:calc(100vw - 82px)!important;}}
    `;
    document.head.appendChild(adminStyle);

    rootEl.querySelector('#road-admin-collapse').addEventListener('click',()=>rootEl.classList.toggle('is-collapsed'));
    rootEl.querySelector('#road-admin-start').addEventListener('click',startDrawing);
    rootEl.querySelector('#road-admin-node-start').addEventListener('click',()=>nodeMode?cancelNodeMode():startNodeMode());
    rootEl.querySelector('#road-admin-node-cancel').addEventListener('click',()=>cancelNodeMode());
    rootEl.querySelector('#road-admin-undo').addEventListener('click',undoPoint);
    rootEl.querySelector('#road-admin-cancel').addEventListener('click',()=>cancelDrawing());
    rootEl.querySelector('#road-admin-finish').addEventListener('click',finishDrawing);
    rootEl.querySelector('#road-admin-toggle').addEventListener('click',()=>{
      if(!isAdmin())return;
      showLayer=!showLayer;
      if(showLayer)renderAdminLayer();else if(map.hasLayer(adminLayers))map.removeLayer(adminLayers);
      rootEl.querySelector('#road-admin-toggle').textContent=showLayer?'Скрыть дороги':'Показать дороги';
    });
    rootEl.querySelector('#road-admin-export').addEventListener('click',exportBackup);
    map.on('mousemove', updateNodePreview);
    map.on('mouseout', clearNodePreview);
    L.DomEvent.disableClickPropagation(rootEl);L.DomEvent.disableScrollPropagation(rootEl);

    // A real-time listener allows public visitors to use admin-added roads for routing, without drawing them.
    const eventsRef=database.ref('road_network_additions/events');
    eventsRef.on('value', snapshot=>{
      const data=snapshot.val()||{};
      remoteEvents=Object.keys(data).map(k=>data[k]).filter(e=>e&&(e.feature || (e.type==='junction-addition' && Array.isArray(e.junctions) && e.junctions.length>0 || e.type==='junction-addition' && Array.isArray(e.bindings) && e.bindings.length>0))).sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
      dbReadError='';rebuildMerged();
      status(remoteEvents.length?'Общие дороги и узлы синхронизированы.':'Синхронизация дорожной сети активна.','is-good');
    }, error=>{
      dbReadError=error&&error.message?error.message:'read denied';
      status('Не удалось прочитать общие дороги из Firebase. Проверьте правила доступа.','is-warning');
      console.warn('[Road Admin] Could not read road additions:',error);
      rebuildMerged();
    });

    // Hide the editor immediately for non-admin sessions and follow the existing auth class.
    const observer=new MutationObserver(setPermission);
    observer.observe(document.body,{attributes:true,attributeFilter:['class']});
    setPermission();
    rebuildMerged();

    return {
      handleMapClick:function(e){
        if (!isAdmin()) return false;
        const p=[Number(e.latlng.lng),Number(e.latlng.lat)];
        if (nodeMode) { createJunctionAt(p); return true; }
        if(!drawing)return false;
        if(controlPoints.length && dist(controlPoints[controlPoints.length-1],p)<1.4){status('Слишком близко к предыдущей точке.','is-warning');return true;}
        if(!inBounds(p)){status('Эта область находится за рабочими границами карты.','is-warning');return true;}
        controlPoints.push(p);renderPreview();status('Точек дороги: '+controlPoints.length+'. Добавляйте изгибы или завершите дорогу.','is-good');return true;
      },
      refreshPermissions:setPermission,
      exportBackup,
      getMergedNetwork:()=>mergedNetwork,
      getMergedTopology:()=>mergedTopology,
      destroy:function(){observer.disconnect();eventsRef.off();map.off('mousemove',updateNodePreview);map.off('mouseout',clearNodePreview);cancelDrawing(true);cancelNodeMode(true);if(map.hasLayer(adminLayers))map.removeLayer(adminLayers);if(adminStyle.parentNode)adminStyle.parentNode.removeChild(adminStyle);rootEl.remove();}
    };
  }

  root.WinterholdRoadAdminEditor={attach};
})(typeof window!=='undefined'?window:globalThis);
