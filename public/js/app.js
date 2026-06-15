/* global Chart */

let charts = {};
let portfolioData = null;

// --- API Helpers ---

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body);
  }
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(errBody);
  }
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body);
  }
  return res.json();
}

// --- Portfolio Operations ---

async function loadPortfolio() {
  const baseCurrency = document.getElementById('baseCurrency').value;
  document.querySelector('main').classList.add('loading');
  try {
    portfolioData = await apiGet('/api/portfolio?base=' + encodeURIComponent(baseCurrency));
    renderTable(portfolioData);
    renderCharts(portfolioData);
  } catch (err) {
    console.error('Failed to load portfolio:', err);
  } finally {
    document.querySelector('main').classList.remove('loading');
  }
}

async function addHolding(ticker, currency, quantity) {
  await apiPost('/api/holdings', { ticker, currency, quantity });
  await loadPortfolio();
}

async function deleteHolding(id) {
  if (!confirm('Remove this holding?')) return;
  await apiDelete('/api/holdings/' + encodeURIComponent(id));
  await loadPortfolio();
}

// Expose to inline onclick handlers
window.deleteHolding = deleteHolding;

async function lookupTicker(ticker) {
  const preview = document.getElementById('tickerPreview');
  const currencyInput = document.getElementById('currency');

  if (!ticker) {
    preview.classList.add('hidden');
    currencyInput.value = '';
    return;
  }

  try {
    const data = await apiGet('/api/lookup/' + encodeURIComponent(ticker));
    preview.classList.remove('hidden', 'error');
    preview.innerHTML =
      '<strong>' + escapeHtml(data.name) + '</strong> (' + escapeHtml(data.ticker) + ') &mdash; ' +
      escapeHtml(data.currency) + ' ' + (data.price != null ? data.price.toFixed(2) : 'N/A') +
      ' | Type: ' + escapeHtml(data.assetType) +
      ' | Region: ' + escapeHtml(data.region) +
      ' | Style: ' + escapeHtml(data.style);
    currencyInput.value = data.currency;
  } catch {
    preview.classList.remove('hidden');
    preview.classList.add('error');
    preview.textContent = 'Ticker "' + ticker + '" not found';
    currencyInput.value = '';
  }
}

// --- Rendering ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatCurrency(value, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return currency + ' ' + value.toFixed(2);
  }
}

function renderTable(data) {
  var tbody = document.getElementById('holdingsBody');
  var emptyMsg = document.getElementById('emptyMessage');
  var table = document.getElementById('holdingsTable');
  var totalCell = document.getElementById('totalValue');

  if (!data.holdings.length) {
    table.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }

  table.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  tbody.innerHTML = data.holdings
    .map(function (h) {
      if (h.error) {
        return (
          '<tr>' +
          '<td><strong>' + escapeHtml(h.ticker) + '</strong></td>' +
          '<td colspan="8" style="color: var(--danger)">Error: ' + escapeHtml(h.error) + '</td>' +
          '<td><button class="delete-btn" onclick="deleteHolding(\'' + escapeHtml(h.id) + '\')">&#x2715;</button></td>' +
          '</tr>'
        );
      }

      var weight =
        data.totalValue > 0
          ? ((h.valueBase / data.totalValue) * 100).toFixed(1)
          : '0.0';

      var typeBadge = 'badge-' + h.assetType.toLowerCase();
      var regionBadge = 'badge-' + h.region.toLowerCase().replace(/\s+/g, '-');

      return (
        '<tr>' +
        '<td><strong>' + escapeHtml(h.ticker) + '</strong></td>' +
        '<td>' + escapeHtml(h.name) + '</td>' +
        '<td><span class="badge ' + typeBadge + '">' + escapeHtml(h.assetType) + '</span></td>' +
        '<td><span class="badge ' + regionBadge + '">' + escapeHtml(h.region) + '</span></td>' +
        '<td>' + escapeHtml(h.style) + '</td>' +
        '<td>' + formatCurrency(h.price, h.currency) + '</td>' +

        '<td>' + h.quantity + '</td>' +
        '<td>' + formatCurrency(h.valueBase, data.baseCurrency) + '</td>' +
        '<td>' + weight + '%</td>' +
        '<td><button class="delete-btn" onclick="deleteHolding(\'' + escapeHtml(h.id) + '\')">&#x2715;</button></td>' +
        '</tr>'
      );
    })
    .join('');

  totalCell.textContent = formatCurrency(data.totalValue, data.baseCurrency);
}

// --- Charts ---

var COLORS = {
  assetType: {
    Stock: '#3b82f6',
    Bond: '#10b981',
    REIT: '#f59e0b',
    Cash: '#6b7280',
    Other: '#8b5cf6',
  },
  region: {
    US: '#3b82f6',
    Australia: '#f59e0b',
    Asia: '#ef4444',
    Europe: '#10b981',
    Global: '#8b5cf6',
    'Global ex-US': '#6366f1',
    Emerging: '#f97316',
    Other: '#6b7280',
  },
  stylePalette: [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1',
  ],
};

function createOrUpdateChart(canvasId, labels, values, colorMap, colorArray) {
  var ctx = document.getElementById(canvasId).getContext('2d');

  if (charts[canvasId]) {
    charts[canvasId].destroy();
  }

  var colors = colorMap
    ? labels.map(function (l) { return colorMap[l] || '#6b7280'; })
    : labels.map(function (_, i) { return colorArray[i % colorArray.length]; });

  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [
        {
          data: values.map(function (v) { return Math.round(v * 100) / 100; }),
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#ffffff',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 14, usePointStyle: true, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.label + ': ' + ctx.parsed.toFixed(1) + '%';
            },
          },
        },
      },
    },
  });
}

function renderCharts(data) {
  var alloc = data.allocation;

  if (Object.keys(alloc.byAssetType).length) {
    createOrUpdateChart(
      'assetTypeChart',
      Object.keys(alloc.byAssetType),
      Object.values(alloc.byAssetType),
      COLORS.assetType
    );
  }

  if (Object.keys(alloc.byRegion).length) {
    createOrUpdateChart(
      'regionChart',
      Object.keys(alloc.byRegion),
      Object.values(alloc.byRegion),
      COLORS.region
    );
  }

  if (Object.keys(alloc.byStyle).length) {
    createOrUpdateChart(
      'styleChart',
      Object.keys(alloc.byStyle),
      Object.values(alloc.byStyle),
      null,
      COLORS.stylePalette
    );
  }
}

// --- Event Handlers ---

var lookupTimeout;

document.getElementById('ticker').addEventListener('blur', function (e) {
  var val = e.target.value.trim();
  if (val) lookupTicker(val);
});

document.getElementById('ticker').addEventListener('input', function (e) {
  clearTimeout(lookupTimeout);
  lookupTimeout = setTimeout(function () {
    var val = e.target.value.trim();
    if (val.length >= 2) lookupTicker(val);
  }, 800);
});

document.getElementById('addForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var ticker = document.getElementById('ticker').value.trim();
  var currency = document.getElementById('currency').value.trim();
  var quantity = document.getElementById('quantity').value;

  if (!ticker || !quantity) return;

  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    await addHolding(ticker, currency, parseFloat(quantity));
    document.getElementById('ticker').value = '';
    document.getElementById('currency').value = '';
    document.getElementById('quantity').value = '';
    document.getElementById('tickerPreview').classList.add('hidden');
  } catch (err) {
    alert('Failed to add holding: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Add';
  }
});

document.getElementById('baseCurrency').addEventListener('change', loadPortfolio);

// --- Init ---

loadPortfolio();
