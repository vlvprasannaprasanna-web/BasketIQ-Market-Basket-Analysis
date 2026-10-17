
const form = document.getElementById("analysisForm");
const fileInput = document.getElementById("csvFile");
const uploadTitle = document.getElementById("uploadTitle");
const uploadSubtitle = document.getElementById("uploadSubtitle");
const analyzeBtn = document.getElementById("analyzeBtn");
const toast = document.getElementById("toast");
const refreshHistoryBtn = document.getElementById("refreshHistory");

let itemsetChart = null;
let ruleChart = null;
let lastResult = null;
let toastTimer = null;

/* --------------------------------------------------
   TOAST MESSAGES
-------------------------------------------------- */
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = "toast show" + (isError ? " error" : "");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4200);
}

function fmtPct(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

/* --------------------------------------------------
   HORIZONTAL NAVIGATION AND SECTION SWITCHING
-------------------------------------------------- */
const navItems = [...document.querySelectorAll(".nav-item")];

const pageElements = {
  overview: [
    document.querySelector(".page-heading"),
    document.querySelector(".metric-grid"),
    document.querySelector(".history-panel")
  ],
  analysis: [
    document.getElementById("analysis")
  ],
  itemsets: [
    document.querySelector(".main-content > .results-heading"),
    document.querySelector(".charts-grid")
  ],
  rules: [
    document.querySelector(".main-content > .results-heading"),
    document.querySelector(".charts-grid"),
    document.querySelector(".table-panel")
  ],
  insights: [
    document.getElementById("insights")
  ]
};

function showPage(pageName) {
  if (!pageElements[pageName]) pageName = "overview";

  // Hide the previous page and show the selected page.
  const allSections = new Set(Object.values(pageElements).flat().filter(Boolean));

  allSections.forEach(section => {
    section.hidden = !pageElements[pageName].includes(section);
  });

  // Show only the relevant chart on its own page.
  const itemsetPanel = document.getElementById("itemsets");
  const rulePanel = document.getElementById("rules");
  const chartsGrid = document.querySelector(".charts-grid");

  if (itemsetPanel) itemsetPanel.hidden = pageName === "rules";
  if (rulePanel) rulePanel.hidden = pageName === "itemsets";

  if (chartsGrid) {
    chartsGrid.classList.toggle(
      "single-chart-view",
      pageName === "itemsets" || pageName === "rules"
    );
  }

  // Update the selected navigation item.
  navItems.forEach(item => {
    const target = item.getAttribute("href")?.replace("#", "");
    item.classList.toggle("active", target === pageName);

    if (target === pageName) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });

  // Keep the address bar in sync without scrolling.
  if (window.location.hash !== `#${pageName}`) {
    history.replaceState(null, "", `#${pageName}`);
  }

  // Let Chart.js recalculate its size after the page becomes visible.
  requestAnimationFrame(() => {
    if (itemsetChart && !itemsetPanel.hidden) itemsetChart.resize();
    if (ruleChart && !rulePanel.hidden) ruleChart.resize();
  });
}

navItems.forEach(item => {
  item.addEventListener("click", event => {
    event.preventDefault();
    const pageName = item.getAttribute("href").replace("#", "");
    showPage(pageName);
  });
});

// The help card's "Start exploring" link opens the analysis page.
document.querySelectorAll('.help-card a[href="#analysis"]').forEach(link => {
  link.addEventListener("click", event => {
    event.preventDefault();
    showPage("analysis");
  });
});

// The main Run analysis button opens the form and starts analysis.
document.getElementById("runTopBtn").addEventListener("click", () => {
  showPage("analysis");
  setTimeout(() => form.requestSubmit(), 100);
});

/* --------------------------------------------------
   RANGE SLIDERS
-------------------------------------------------- */
function setRangeLabel(inputId, labelId, formatter) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);

  const update = () => {
    label.textContent = formatter(Number(input.value));
  };

  input.addEventListener("input", update);
  update();
}

setRangeLabel("minSupport", "supportValue", value =>
  `${Math.round(value * 100)}%`
);

setRangeLabel("minConfidence", "confidenceValue", value =>
  `${Math.round(value * 100)}%`
);

setRangeLabel("minLift", "liftValue", value =>
  `${value.toFixed(2)}×`
);

/* --------------------------------------------------
   CSV UPLOAD DISPLAY
-------------------------------------------------- */
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  if (file) {
    uploadTitle.textContent = file.name;
    uploadSubtitle.textContent =
      `${(file.size / 1024).toFixed(1)} KB · Ready to analyze`;
  } else {
    uploadTitle.textContent = "Upload your transaction CSV";
    uploadSubtitle.textContent =
      "CSV with transaction_id and product columns, or use the sample dataset";
  }
});

/* --------------------------------------------------
   RUN ANALYSIS
-------------------------------------------------- */
form.addEventListener("submit", async event => {
  event.preventDefault();

  const formData = new FormData(form);

  if (!fileInput.files.length) {
    formData.delete("file");
  }

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = "<span>◌</span> Analyzing transactions…";
  document.body.classList.add("loading");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
      cache: "no-store"
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "The analysis could not be completed.");
    }

    lastResult = result;
    renderResults(result);

    document.getElementById("resultSubtitle").textContent =
      `${result.source} · ${result.transaction_count.toLocaleString()} transactions analyzed`;

    document.getElementById("algorithmPill").textContent =
      `${result.algorithm} · complete`;

    await loadHistory();

    showToast(
      `Analysis complete: ${result.total_frequent_itemsets} frequent itemsets and ${result.total_rules_after_filters} association rules.`
    );

    // Open the results page after a successful run.
    showPage("itemsets");
  } catch (error) {
    showToast(
      error.message || "Something went wrong. Please check your CSV and try again.",
      true
    );
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = "<span>✦</span> Analyze transactions <span>→</span>";
    document.body.classList.remove("loading");
  }
});

/* --------------------------------------------------
   UPDATE METRICS AND RESULTS
-------------------------------------------------- */
function renderResults(data) {
  document.getElementById("transactionMetric").textContent =
    Number(data.transaction_count).toLocaleString();

  document.getElementById("productMetric").textContent =
    Number(data.product_count).toLocaleString();

  document.getElementById("itemsetMetric").textContent =
    Number(data.total_frequent_itemsets).toLocaleString();

  document.getElementById("ruleMetric").textContent =
    Number(data.total_rules_after_filters).toLocaleString();

  renderItemsetChart(data.itemsets || []);
  renderRuleChart(data.rules || []);
  renderRulesTable(data.rules || []);
  renderInsights(data.insights || []);

  document.getElementById("exportRules").disabled =
    !(data.rules && data.rules.length);
}

function showChartEmpty(canvasId, emptyId, hasData) {
  document.getElementById(canvasId).style.display =
    hasData ? "block" : "none";

  document.getElementById(emptyId).style.display =
    hasData ? "none" : "flex";
}

/* --------------------------------------------------
   CHART DESIGN HELPERS
-------------------------------------------------- */
function makeGradient(canvas, startColor, endColor) {
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, canvas.width || 400, 0);

  gradient.addColorStop(0, startColor);
  gradient.addColorStop(1, endColor);

  return gradient;
}

function chartOptions(valueLabel, suffix = "") {
  return {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 850,
      easing: "easeOutQuart"
    },
    layout: {
      padding: { top: 6, right: 14, bottom: 4, left: 4 }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#173c2a",
        titleColor: "#ffffff",
        bodyColor: "#e5f5e9",
        padding: 12,
        cornerRadius: 9,
        displayColors: false,
        callbacks: {
          label: context =>
            ` ${valueLabel}: ${Number(context.raw).toFixed(2)}${suffix}`
        }
      }
    },
    scales: {
      x: {
        beginAtZero: true,
        grid: {
          color: "rgba(46, 139, 87, 0.10)",
          drawTicks: false
        },
        ticks: {
          color: "#748779",
          padding: 8,
          font: { family: "DM Sans", size: 10 },
          callback: value => `${value}${suffix}`
        },
        border: { display: false }
      },
      y: {
        grid: { display: false },
        ticks: {
          color: "#496353",
          padding: 8,
          font: { family: "DM Sans", size: 10, weight: "600" }
        },
        border: { display: false }
      }
    }
  };
}

/* --------------------------------------------------
   FREQUENT ITEMSETS CHART
-------------------------------------------------- */
function renderItemsetChart(itemsets) {
  const rows = itemsets
    .filter(row => row.length >= 2)
    .slice(0, 8)
    .reverse();

  showChartEmpty("itemsetChart", "itemsetChartEmpty", rows.length > 0);

  if (!rows.length) {
    if (itemsetChart) {
      itemsetChart.destroy();
      itemsetChart = null;
    }
    return;
  }

  if (typeof Chart === "undefined") {
    showToast("Chart.js did not load. Check your internet connection.", true);
    return;
  }

  if (itemsetChart) itemsetChart.destroy();

  const canvas = document.getElementById("itemsetChart");

  itemsetChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map(row => row.label),
      datasets: [{
        label: "Support",
        data: rows.map(row => row.support * 100),
        backgroundColor: makeGradient(canvas, "#75d6a0", "#218653"),
        hoverBackgroundColor: "#176b40",
        borderRadius: 8,
        borderSkipped: false,
        barThickness: 20,
        maxBarThickness: 25
      }]
    },
    options: chartOptions("Support", "%")
  });
}

/* --------------------------------------------------
   ASSOCIATION RULES CHART
-------------------------------------------------- */
function renderRuleChart(rules) {
  const rows = [...rules]
    .sort((a, b) => a.lift - b.lift)
    .slice(-8);

  showChartEmpty("ruleChart", "ruleChartEmpty", rows.length > 0);

  if (!rows.length) {
    if (ruleChart) {
      ruleChart.destroy();
      ruleChart = null;
    }
    return;
  }

  if (typeof Chart === "undefined") {
    showToast("Chart.js did not load. Check your internet connection.", true);
    return;
  }

  if (ruleChart) ruleChart.destroy();

  const canvas = document.getElementById("ruleChart");

  ruleChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map(row =>
        row.rule.length > 38 ? row.rule.slice(0, 35) + "…" : row.rule
      ),
      datasets: [{
        label: "Lift",
        data: rows.map(row => row.lift),
        backgroundColor: makeGradient(canvas, "#ffd29a", "#df853c"),
        hoverBackgroundColor: "#bd6729",
        borderRadius: 8,
        borderSkipped: false,
        barThickness: 20,
        maxBarThickness: 25
      }]
    },
    options: chartOptions("Lift", "×")
  });
}

/* --------------------------------------------------
   ASSOCIATION RULES TABLE
-------------------------------------------------- */
function renderRulesTable(rules) {
  const body = document.getElementById("rulesTable");
  const shown = rules.slice(0, 30);

  if (!shown.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty-cell">No rules match these filters. Try lowering minimum confidence or lift.</td></tr>';

    document.getElementById("rulesCount").textContent = "Showing 0 rules";
    return;
  }

  body.innerHTML = shown.map(rule => {
    const chips = values => values.map(value =>
      `<span class="product-chip" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`
    ).join(" ");

    const strength =
      rule.lift >= 1.5 ? "Strong" :
      rule.lift > 1 ? "Positive" : "Weak";

    return `<tr>
      <td><div class="rule-products">${chips(rule.antecedents)}</div></td>
      <td><div class="rule-products">${chips(rule.consequents)}</div></td>
      <td>${fmtPct(rule.support)}</td>
      <td>
        <div class="confidence-track">
          ${fmtPct(rule.confidence)}
          <span><i style="width:${Math.min(100, rule.confidence * 100)}%"></i></span>
        </div>
      </td>
      <td><span class="lift-badge">${Number(rule.lift).toFixed(2)}×</span></td>
      <td class="strength">${strength}</td>
    </tr>`;
  }).join("");

  document.getElementById("rulesCount").textContent =
    `Showing ${shown.length} of ${rules.length} rules`;
}

/* --------------------------------------------------
   BUSINESS INSIGHTS
-------------------------------------------------- */
function renderInsights(insights) {
  const grid = document.getElementById("insightGrid");

  if (!insights.length) {
    grid.innerHTML = `
      <article class="insight-card insight-placeholder">
        <div class="insight-number">!</div>
        <div>
          <h3>No recommendations generated yet</h3>
          <p>No rules met the current thresholds. Try relaxing one or more thresholds.</p>
        </div>
      </article>`;
    return;
  }

  grid.innerHTML = insights.map((item, index) => `
    <article class="insight-card">
      <div class="insight-number">${String(index + 1).padStart(2, "0")}</div>
      <div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description)}</p>
        <div class="insight-action">
          <b>Suggested action:</b> ${escapeHtml(item.action)}
        </div>
      </div>
    </article>`
  ).join("");
}

/* --------------------------------------------------
   EXPORT RULES
-------------------------------------------------- */
document.getElementById("exportRules").addEventListener("click", () => {
  if (!lastResult || !lastResult.rules || !lastResult.rules.length) return;

  const columns = [
    "antecedents", "consequents", "support",
    "confidence", "lift", "leverage", "conviction"
  ];

  const quote = value =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const lines = [columns.join(",")].concat(
    lastResult.rules.map(rule =>
      columns.map(column =>
        quote(Array.isArray(rule[column])
          ? rule[column].join(" + ")
          : rule[column])
      ).join(",")
    )
  );

  const blob = new Blob([lines.join("\r\n")], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "association_rules.csv";
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* --------------------------------------------------
   RECENT ANALYSIS HISTORY AND REFRESH
-------------------------------------------------- */
if (refreshHistoryBtn) {
  refreshHistoryBtn.addEventListener("click", async () => {
    refreshHistoryBtn.disabled = true;
    refreshHistoryBtn.textContent = "↻ Refreshing…";

    try {
      await loadHistory();
      showToast("Recent analysis history refreshed.");
    } catch {
      showToast("Could not refresh history. Please try again.", true);
    } finally {
      refreshHistoryBtn.disabled = false;
      refreshHistoryBtn.textContent = "↻ Refresh";
    }
  });
}

async function loadHistory() {
  const body = document.getElementById("historyTable");

  try {
    const response = await fetch("/api/history", {
      method: "GET",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    if (!response.ok) {
      throw new Error("History request failed.");
    }

    const history = await response.json();

    if (!Array.isArray(history)) {
      throw new Error("Unexpected history response.");
    }

    if (!history.length) {
      body.innerHTML =
        '<tr><td colspan="6" class="empty-cell">No saved analyses yet. Run an analysis to create history.</td></tr>';
      return;
    }

    body.innerHTML = history.map(row => `
      <tr>
        <td>${escapeHtml(String(row.created_at || "—").replace("T", " "))}</td>
        <td>${escapeHtml(row.source || "—")}</td>
        <td><span class="pill pill-neutral">${escapeHtml(row.algorithm || "—")}</span></td>
        <td>${Number(row.transaction_count || 0).toLocaleString()}</td>
        <td>${Number(row.itemset_count || 0).toLocaleString()}</td>
        <td>${Number(row.rule_count || 0).toLocaleString()}</td>
      </tr>`
    ).join("");
  } catch (error) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty-cell">Could not load history. Check that the Flask server is running, then refresh.</td></tr>';
    throw error;
  }
}

/* --------------------------------------------------
   STARTUP
-------------------------------------------------- */
const initialPage = window.location.hash.replace("#", "");
showPage(pageElements[initialPage] ? initialPage : "overview");

loadHistory().catch(() => {
  // The history table already displays a useful error message.
});
