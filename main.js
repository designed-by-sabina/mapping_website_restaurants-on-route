// Supabase
const { createClient } = window.supabase;
const supabaseUrl = "https://edfijuldigkxpfebbbre.supabase.co";
const supabaseKey = "sb_publishable_4KxA1Kji8m0DO4FD616pJg_jUCfxkRk";
const supabaseClient = createClient(supabaseUrl, supabaseKey);


var map = new maplibregl.Map({
  container: "map", // container id
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", // grayscale basemap, no API key needed
  center: [-73.97144, 40.70491], // starting position [lng, lat]
  zoom: 11, // starting zoom
});

map.addControl(new maplibregl.NavigationControl());

const SEARCH_RADIUS_METERS = 1609; // 1 mile

// Bumped on every call so a slow response from an earlier point (e.g. from
// mid-drag) can't land after a newer one and make the display jump back -
// that's what was causing restaurants to "linger" while dragging.
let queryRequestId = 0;

async function queryWithinDistance(point, n = SEARCH_RADIUS_METERS) {
  const requestId = ++queryRequestId;

  const { data, error } = await supabaseClient.rpc("find_nearest_n_restaurants", {
    lat: point[1],
    lon: point[0],
    n: n,
  });

  if (requestId !== queryRequestId) return; // a newer query has since been made - drop this one

  if (error) {
    console.error("Error fetching nearest points:", error);
    return;
  }

  console.log(`Found ${data.length} inspections within ${n}m`);

  // Reshape the rows returned by the RPC into a GeoJSON FeatureCollection
  // that the map's "restaurants" source can display.
  const geojson = {
    type: "FeatureCollection",
    features: data.map((row) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [row.long, row.lat],
      },
      properties: {
        id: row.RestaurantInspectionID,
        name: row.name,
        seating_choice: row.seating_choice,
        dist_meters: row.dist_meters,
      },
    })),
  };

  // Supabase/PostgREST caps RPC results at 1000 rows, so in dense areas the
  // farthest restaurant actually returned can be well short of the full
  // search radius (e.g. ~500m instead of 1609m). Scaling the size
  // interpolation against SEARCH_RADIUS_METERS in that case barely moves
  // the radius at all. Instead, scale against the farthest point actually
  // returned for *this* click, so the size gradient is always visible.
  const maxDist = data.length ? Math.max(...data.map((row) => row.dist_meters)) : n;
  map.setPaintProperty("nearby-restaurants-layer", "circle-radius", [
    "interpolate",
    ["linear"],
    ["get", "dist_meters"],
    0,
    7,
    Math.max(maxDist, 1),
    2.5,
  ]);

  map.getSource("nearby-restaurants").setData(geojson);
}

let routeLine = null; // turf LineString feature, filled in once central_park_route.geojson loads
let routeMarker = null;
let routeReadoutLabel = null;
let routeReadoutDist = null;

function metersToMiles(m) {
  return m / 1609.34;
}

function updateRouteReadout(distAlongMeters, totalMeters) {
  if (!routeReadoutLabel || !routeReadoutDist) return;
  routeReadoutLabel.textContent = "On Central Park route";
  routeReadoutDist.textContent =
    `${metersToMiles(distAlongMeters).toFixed(2)} mi into the ${metersToMiles(totalMeters).toFixed(2)} mi route`;
}

// Snap a raw [lng, lat] to the nearest point on the Central Park route and
// move the marker there. Cheap and synchronous, so this can run on every
// pointer-move frame for a smooth slide.
function snapMarkerToRoute(lngLat) {
  if (!routeLine) return null;

  const snapped = turf.nearestPointOnLine(routeLine, [lngLat.lng, lngLat.lat]);
  const snappedCoords = snapped.geometry.coordinates;

  routeMarker.setLngLat(snappedCoords);

  const totalMeters = turf.length(routeLine, { units: "kilometers" }) * 1000;
  const distAlongMeters = snapped.properties.location * 1000; // km -> m
  updateRouteReadout(distAlongMeters, totalMeters);

  return snappedCoords;
}

// The Supabase round-trip is the slow part, so it's throttled separately
// from marker movement - firing it on every frame during a fast drag is
// what made the restaurant bubbles lag behind and flicker between points.
let proximityQueryTimer = null;
const PROXIMITY_QUERY_THROTTLE_MS = 120;

function queueProximityQuery(coords, immediate = false) {
  clearTimeout(proximityQueryTimer);
  if (immediate) {
    queryWithinDistance(coords, SEARCH_RADIUS_METERS);
    return;
  }
  proximityQueryTimer = setTimeout(() => {
    queryWithinDistance(coords, SEARCH_RADIUS_METERS);
  }, PROXIMITY_QUERY_THROTTLE_MS);
}

// Move the marker and (throttled) re-run the proximity query for that spot -
// this is what makes "drag the point" behave like "click the point".
function snapMarkerAndQuery(lngLat, immediate = false) {
  const snappedCoords = snapMarkerToRoute(lngLat);
  if (!snappedCoords) return;
  queueProximityQuery(snappedCoords, immediate);
}

// The marker itself is never draggable - it always sits at whatever point
// snapMarkerAndQuery() puts it at, so it can never leave the route line.
// This drives it like a slider: while the mouse/touch is down on it, we
// read the cursor's map position on every move and re-snap the marker to
// the nearest point on the route, instead of letting it follow the cursor.
function enableRouteMarkerSlider() {
  const el = routeMarker.getElement();
  el.style.cursor = "grab";

  let dragging = false;
  let rafPending = false;
  let lastLngLat = null;

  const onMove = (e) => {
    if (!dragging) return;
    lastLngLat = e.lngLat;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dragging) snapMarkerAndQuery(lastLngLat);
    });
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
    map.dragPan.enable();
    // Make sure the very last position always gets queried, even if it
    // landed inside the throttle window and would otherwise be skipped.
    if (lastLngLat) snapMarkerAndQuery(lastLngLat, true);
    map.off("mousemove", onMove);
    map.off("touchmove", onMove);
    map.off("mouseup", onUp);
    map.off("touchend", onUp);
    window.removeEventListener("mouseup", onUp);
  };

  const onDown = (e) => {
    e.preventDefault();
    dragging = true;
    el.style.cursor = "grabbing";
    map.dragPan.disable(); // keep the map still while sliding the point
    map.on("mousemove", onMove);
    map.on("touchmove", onMove);
    map.on("mouseup", onUp);
    map.on("touchend", onUp);
    window.addEventListener("mouseup", onUp); // catch release outside the canvas
  };

  el.addEventListener("mousedown", onDown);
  el.addEventListener("touchstart", onDown, { passive: false });
}

map.on("load", () => {

  map.addSource("all-restaurants", {
    type: "geojson",
    data: "all_restaurants.geojson",
  });

  map.addLayer({
    id: "all-restaurants-layer",
    type: "circle",
    source: "all-restaurants",
    paint: {
      "circle-radius": 2.5,
      "circle-color": "#333333",
      "circle-opacity": 0.5,
    },
  });

  // Highlight layer: only the restaurants returned by the last click query,
  // drawn on top of the grey base layer so they stand out.
  map.addSource("nearby-restaurants", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "nearby-restaurants-layer",
    type: "circle",
    source: "nearby-restaurants",
    paint: {
      // Data-driven color by seating choice, matching the legend
      "circle-color": [
        "match",
        ["get", "seating_choice"],
        "sidewalk",
        "#1f78b4",
        "roadway",
        "#ff7f00",
        "both",
        "#6a3d9a",
        "openstreets",
        "#33a02c",
        /* other */ "#999999",
      ],
      // Data-driven radius by distance from the clicked point -
      // closer restaurants are drawn bigger, so the map encodes both
      // the seating-choice variable (color) and distance (size) at once.
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["get", "dist_meters"],
        0,
        7,
        SEARCH_RADIUS_METERS,
        2.5,
      ],
      "circle-opacity": 0.9,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "black",
      "circle-radius-transition": { duration: 150, delay: 0 },
      "circle-opacity-transition": { duration: 150, delay: 0 },
    },
  });


  // Clicking a highlighted (colored) restaurant point shows its details.
  map.on("click", "nearby-restaurants-layer", (e) => {
    const coordinates = e.features[0].geometry.coordinates.slice();
    const { name, seating_choice, dist_meters } = e.features[0].properties;
    const dist_miles = dist_meters / 1609.34;
    new maplibregl.Popup()
      .setLngLat(coordinates)
      .setHTML(
        `<strong>${name}</strong><br>` +
          `Seating: ${seating_choice}<br>` +
          `${dist_miles.toFixed(2)} mi from route marker`
      )
      .addTo(map);
  });

  map.on("mouseenter", "nearby-restaurants-layer", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "nearby-restaurants-layer", () => (map.getCanvas().style.cursor = ""));

  // --- Central Park attractions route + draggable proximity point ---

  map.addSource("central-park-route", {
    type: "geojson",
    data: "central_park_route.geojson",
  });

  map.addLayer({
    id: "central-park-route-layer",
    type: "line",
    source: "central-park-route",
    paint: {
      "line-color": "#e31a1c",
      "line-width": 3,
      "line-opacity": 0.85,
    },
  });

  map.addSource("central-park-attractions", {
    type: "geojson",
    data: "central_park_attractions_ordered.geojson",
  });

  map.addLayer({
    id: "central-park-attractions-layer",
    type: "circle",
    source: "central-park-attractions",
    paint: {
      "circle-radius": 4,
      "circle-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#e31a1c",
    },
  });

  routeReadoutLabel = document.getElementById("route-readout-label");
  routeReadoutDist = document.getElementById("route-readout-dist");

  fetch("central_park_route.geojson")
    .then((res) => res.json())
    .then((geojson) => {
      routeLine = geojson.features[0];

      const startCoords = routeLine.geometry.coordinates[0];

      routeMarker = new maplibregl.Marker({ color: "#111", draggable: false })
        .setLngLat(startCoords)
        .addTo(map);

      enableRouteMarkerSlider();

      // Place it on the route and run the first proximity query immediately.
      snapMarkerAndQuery({ lng: startCoords[0], lat: startCoords[1] }, true);
    });
});
