const COLOR = { blue: "#3975a7", gold: "#9b7d32", green: "#43815c" };
const tabOrder = [1, 6, 4, 5, 7, 2, 8, 3, 9, 10];
const elements = {
  tabs: document.querySelector("#lineTabs"),
  lineCaption: document.querySelector("#lineCaption"),
  lineName: document.querySelector("#lineName"),
  routeTitle: document.querySelector("#routeTitle"),
  routeDirection: document.querySelector(".route-direction"),
  route: document.querySelector("#route"),
  notice: document.querySelector("#notice"),
  updateTime: document.querySelector("#updateTime"),
  refresh: document.querySelector("#refreshButton"),
  auto: document.querySelector("#autoRefresh"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
};
let lines = [];
let selectedLine = null;
let refreshTimer = null;
let isLoading = false;
let pendingRefresh = false;

function escapeText(value) {
  return String(value ?? "");
}

function getColor(line) {
  return COLOR[line?.color] || COLOR.blue;
}

function directionInfo(position) {
  const stations = selectedLine?.stations || [];
  const first = stations[0];
  const last = stations[stations.length - 1];
  const rawDirection = position.direction ?? position.direction_id ?? position.direction_type;
  let towardEnd = null;

  // Ordered station IDs describe actual movement more directly than direction codes.
  const from = stationId(position.from_station_id ?? position.from_station, selectedLine);
  const to = stationId(position.to_station_id ?? position.to_station, selectedLine);
  const fromIndex = stations.findIndex((station) => station.id === from);
  const toIndex = stations.findIndex((station) => station.id === to);
  if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
    towardEnd = toIndex > fromIndex;
  }

  const destinationValue = position.destination_name ?? position.destination
    ?? position.line_destination_name ?? position.line_destination;
  const destinationStationId = stationId(destinationValue, selectedLine);
  const destinationIndex = stations.findIndex((station) => station.id === destinationStationId);
  const originIndex = fromIndex >= 0 ? fromIndex : toIndex;
  if (towardEnd === null && destinationIndex >= 0) {
    if (originIndex >= 0 && originIndex !== destinationIndex) {
      towardEnd = destinationIndex > originIndex;
    } else if (originIndex < 0 && destinationIndex === stations.length - 1) {
      towardEnd = true;
    } else if (originIndex < 0 && destinationIndex === 0) {
      towardEnd = false;
    }
  }

  // Observed API values: 0 toward the first station, 1 toward the last station.
  if (towardEnd === null && rawDirection != null && rawDirection !== "") {
    const numeric = Number(rawDirection);
    if (numeric === 0 || numeric === 1) {
      towardEnd = numeric === 1;
    } else if (!Number.isFinite(numeric)) {
      const value = String(rawDirection).trim().toLowerCase();
      if (["down", "downward", "forward", "下り"].includes(value)) towardEnd = true;
      if (["up", "upward", "reverse", "上り"].includes(value)) towardEnd = false;
    }
  }

  const destinationName = typeof destinationValue === "string" ? destinationValue : "";
  const endName = towardEnd === true ? last?.name : towardEnd === false ? first?.name : "";
  const name = destinationName || endName;
  return {
    towardEnd,
    arrow: towardEnd === true ? "↓" : towardEnd === false ? "↑" : "↕",
    label: name ? `${name}方面` : "方向不明",
  };
}

function showConnection(connected, message) {
  elements.connectionDot.classList.toggle("offline", !connected);
  elements.connectionText.textContent = message;
}

function setNotice(message, kind = "info") {
  elements.notice.hidden = !message;
  elements.notice.textContent = message || "";
  elements.notice.dataset.kind = kind;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date) + " JST";
}

function textForPosition(position) {
  const operation = position.operation_number ?? position.operationNumber ?? position.train_number ?? position.train_no ?? position.trainNo;
  const kind = position.train_kind_name ?? position.train_kind ?? position.train_type ?? position.kind_name ?? position.kind;
  const destination = position.destination_name ?? position.destination ?? position.line_destination_name ?? position.line_destination ?? position.to_station_name;
  return {
    title: operation != null && operation !== "" ? `運行番号 ${operation}` : "列車",
    subtitle: [kind, destination].filter((part) => part != null && part !== "").map(escapeText).join(" · "),
  };
}

function detailRows(position) {
  const known = [
    ["運行番号", ["operation_number", "operationNumber", "train_number", "train_no"]],
    ["行先", ["destination_name", "destination", "line_destination_name", "line_destination"]],
    ["種別", ["train_kind_name", "train_kind", "train_type", "kind_name"]],
    ["遅延", ["delay_minutes", "delay_min", "delay_time", "delay"]],
    ["到着見込", ["estimated_arrival_time", "arrival_estimated_time", "arrival_time", "arrival_estimate"]],
    ["現在駅", ["from_station_name", "from_station"]],
    ["次駅", ["to_station_name", "to_station"]],
  ];
  const rows = [];
  for (const [label, keys] of known) {
    const key = keys.find((candidate) => {
      const value = position[candidate];
      return value != null && value !== "" && typeof value !== "object";
    });
    if (key) rows.push([label, position[key]]);
  }
  if (!rows.length) {
    for (const [key, value] of Object.entries(position)) {
      if (value == null || typeof value === "object") continue;
      rows.push([key.replaceAll("_", " "), value]);
      if (rows.length === 5) break;
    }
  }
  return rows;
}

function trainCard(position, location) {
  const details = document.createElement("details");
  details.className = "train-card";
  const summary = document.createElement("summary");
  const icon = document.createElement("span");
  icon.className = "train-icon";
  icon.textContent = "列";
  const heading = document.createElement("span");
  heading.className = "train-copy";
  const label = textForPosition(position);
  const direction = directionInfo(position);
  const directionBadge = document.createElement("span");
  directionBadge.className = `train-direction ${direction.towardEnd === null ? "direction-unknown" : direction.towardEnd ? "direction-down" : "direction-up"}`;
  directionBadge.setAttribute("aria-label", `進行方向: ${direction.label}`);
  const directionArrow = document.createElement("span");
  directionArrow.className = "direction-arrow";
  directionArrow.setAttribute("aria-hidden", "true");
  directionArrow.textContent = direction.arrow;
  const directionText = document.createElement("span");
  directionText.textContent = direction.label;
  directionBadge.append(directionArrow, directionText);
  const title = document.createElement("span");
  title.className = "train-title";
  title.textContent = label.title;
  heading.append(title);
  if (label.subtitle) {
    const subtitle = document.createElement("span");
    subtitle.className = "train-subtitle";
    subtitle.textContent = label.subtitle;
    heading.append(document.createElement("br"), subtitle);
  }
  summary.append(icon, directionBadge, heading);
  details.append(summary);
  const data = document.createElement("dl");
  data.className = "train-data";
  for (const [name, value] of detailRows(position)) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = name;
    dd.textContent = escapeText(value);
    row.append(dt, dd);
    data.append(row);
  }
  const locationRow = document.createElement("div");
  const locationLabel = document.createElement("dt");
  const locationValue = document.createElement("dd");
  locationLabel.textContent = "表示位置";
  locationValue.textContent = location;
  locationRow.append(locationLabel, locationValue);
  data.append(locationRow);
  details.append(data);
  return details;
}

function stationId(value, line) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const station = line.stations.find((item) => item.name === value || item.kana === value);
  return station?.id ?? null;
}

function positionAtStation(position, station) {
  const from = stationId(position.from_station_id ?? position.from_station, selectedLine);
  const to = position.to_station_id ?? position.to_station;
  return from === station.id && (to == null || to === "");
}

function positionBetween(position, previous, next) {
  const from = stationId(position.from_station_id ?? position.from_station, selectedLine);
  const to = stationId(position.to_station_id ?? position.to_station, selectedLine);
  if (from == null || to == null) return false;

  const towardEnd = directionInfo(position).towardEnd;
  const forward = from === previous.id && to === next.id;
  const reverse = from === next.id && to === previous.id;
  if (towardEnd === null) return forward || reverse;
  return towardEnd ? forward : reverse;
}

function renderTrainList(container, positions, location) {
  container.replaceChildren();
  for (const position of positions) container.append(trainCard(position, location));
}

function renderRoute(payload) {
  if (!selectedLine) return;
  const stations = selectedLine.stations;
  const positions = payload.positions || [];
  elements.route.replaceChildren();
  elements.route.style.setProperty("--route-color", getColor(selectedLine));

  stations.forEach((station, index) => {
    const stationRow = document.createElement("div");
    stationRow.className = "route-station";
    const label = document.createElement("div");
    label.className = "station-label";
    const name = document.createElement("span");
    name.className = "station-name";
    name.textContent = station.name;
    const kana = document.createElement("span");
    kana.className = "station-kana";
    kana.textContent = station.kana || "";
    label.append(name, kana);

    const node = document.createElement("div");
    node.className = "station-node";
    node.setAttribute("aria-label", station.name);

    const trains = document.createElement("div");
    trains.className = "station-trains";
    const stopped = positions.filter((position) => positionAtStation(position, station));
    renderTrainList(trains, stopped, `${station.name}駅`);
    stationRow.append(label, node, trains);
    elements.route.append(stationRow);

    if (index >= stations.length - 1) return;
    const next = stations[index + 1];
    const segment = document.createElement("div");
    segment.className = "route-segment";
    const segmentName = document.createElement("div");
    segmentName.className = "segment-empty";
    segmentName.textContent = "";
    const axis = document.createElement("div");
    axis.className = "segment-axis";
    const running = document.createElement("div");
    running.className = "segment-trains";
    const moving = positions.filter((position) => positionBetween(position, station, next));
    renderTrainList(running, moving, `${station.name} 〜 ${next.name} 間`);
    segment.append(segmentName, axis, running);
    elements.route.append(segment);
  });

  if (positions.length === 0 && payload.state !== "finished" && payload.state !== "under_maintenance") {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "現在表示できる車両はありません。";
    elements.route.append(empty);
  }
}

function setLine(line) {
  selectedLine = line;
  const color = getColor(line);
  elements.lineCaption.textContent = `ROUTE ${String(line.id).padStart(2, "0")}`;
  elements.lineName.textContent = line.name;
  elements.routeTitle.textContent = line.name;
  const firstStation = line.stations[0]?.name;
  const lastStation = line.stations[line.stations.length - 1]?.name;
  elements.routeDirection.textContent = firstStation && lastStation
    ? `↑ ${firstStation}方面　↓ ${lastStation}方面`
    : "進行方向は列車の矢印で表示";
  elements.routeDirection.setAttribute("aria-label", firstStation && lastStation
    ? `上向きは${firstStation}方面、下向きは${lastStation}方面`
    : "列車の進行方向");
  elements.route.style.setProperty("--route-color", color);
  for (const button of elements.tabs.querySelectorAll(".line-tab")) {
    const active = Number(button.dataset.lineId) === line.id;
    button.setAttribute("aria-current", active ? "true" : "false");
  }
  loadPositions();
}

function renderTabs() {
  elements.tabs.replaceChildren();
  for (const line of lines) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "line-tab";
    button.dataset.lineId = String(line.id);
    button.style.setProperty("--tab-color", getColor(line));
    button.textContent = line.name;
    button.setAttribute("aria-current", line.id === selectedLine?.id ? "true" : "false");
    button.addEventListener("click", () => {
      if (line.id !== selectedLine?.id) setLine(line);
    });
    elements.tabs.append(button);
  }
}

async function loadPositions() {
  if (!selectedLine) return;
  if (isLoading) {
    pendingRefresh = true;
    return;
  }
  const requestedLine = selectedLine;
  isLoading = true;
  elements.refresh.disabled = true;
  elements.refresh.innerHTML = '<span aria-hidden="true">↻</span> 取得中';
  setNotice("");
  try {
    const response = await fetch(`/api/positions?line_id=${requestedLine.id}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (selectedLine?.id !== requestedLine.id) return;
    renderRoute(payload);
    elements.updateTime.textContent = formatTime(payload.timestamp);
    showConnection(true, "阪急API 接続中");
    if (payload.state === "finished") {
      setNotice("現在営業時間外です。車両位置の配信は始発後に再開します。");
    } else if (payload.state === "under_maintenance") {
      setNotice("車両位置APIはメンテナンス中です。");
    } else if (!payload.positions?.length) {
      setNotice("現在表示できる車両はありません。");
    }
  } catch (error) {
    if (selectedLine?.id !== requestedLine.id) return;
    showConnection(false, "阪急APIに接続できません");
    setNotice(`位置情報を取得できませんでした: ${error.message}`, "error");
    if (!elements.route.childElementCount) {
      elements.route.innerHTML = '<div class="empty-state">路線図を表示できません。</div>';
    }
  } finally {
    isLoading = false;
    elements.refresh.disabled = false;
    elements.refresh.innerHTML = '<span aria-hidden="true">↻</span> 更新';
    if (pendingRefresh || selectedLine?.id !== requestedLine.id) {
      pendingRefresh = false;
      void loadPositions();
    }
  }
}

function updateAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  if (elements.auto.checked) refreshTimer = setInterval(loadPositions, 30000);
}

async function start() {
  elements.refresh.addEventListener("click", loadPositions);
  elements.auto.addEventListener("change", updateAutoRefresh);
  try {
    const response = await fetch("/api/lines", { cache: "no-store" });
    if (!response.ok) throw new Error("路線一覧を読み込めませんでした。");
    lines = await response.json();
    lines.sort((a, b) => tabOrder.indexOf(a.id) - tabOrder.indexOf(b.id));
    renderTabs();
    setLine(lines[0]);
    updateAutoRefresh();
  } catch (error) {
    showConnection(false, "画面の初期化に失敗しました");
    setNotice(error.message, "error");
    elements.route.textContent = "路線情報を読み込めませんでした。";
  }
}

start();
