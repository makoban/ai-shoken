// ========================================
// AI出店商圏レポート v1.5
// エリア入力 → 政府統計 + AI分析 → プレビュー/課金
// ========================================

// ---- Config ----
var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
// Stripe SDK は不要（CRITICAL-01修正: window.location.href でリダイレクト）
var SUPABASE_URL = 'https://ypyrjsdotkeyvzequdez.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_l5yNWlXOZAHABwlbEalGng_R8zioydf';
var supabaseClient = null;
var currentUser = null;

// ---- Prefecture Codes ----
var PREFECTURE_CODES = {
  '北海道':'01','青森県':'02','岩手県':'03','宮城県':'04','秋田県':'05',
  '山形県':'06','福島県':'07','茨城県':'08','栃木県':'09','群馬県':'10',
  '埼玉県':'11','千葉県':'12','東京都':'13','神奈川県':'14','新潟県':'15',
  '富山県':'16','石川県':'17','福井県':'18','山梨県':'19','長野県':'20',
  '岐阜県':'21','静岡県':'22','愛知県':'23','三重県':'24','滋賀県':'25',
  '京都府':'26','大阪府':'27','兵庫県':'28','奈良県':'29','和歌山県':'30',
  '鳥取県':'31','島根県':'32','岡山県':'33','広島県':'34','山口県':'35',
  '徳島県':'36','香川県':'37','愛媛県':'38','高知県':'39','福岡県':'40',
  '佐賀県':'41','長崎県':'42','熊本県':'43','大分県':'44','宮崎県':'45',
  '鹿児島県':'46','沖縄県':'47'
};

// ---- State ----
var analysisData = null;
var currentArea = null;
var isPurchased = false;
var _analysisRunning = false;

// ---- DOM References ----
var areaInput = document.getElementById('area-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorMsg = document.getElementById('error-msg');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');
var resultsContent = document.getElementById('results-content');
var progressLogContent = document.getElementById('progress-log-content');

// ---- On Load: Check for Stripe redirect ----
var _pendingVerifySessionId = null;

(function checkPurchaseReturn() {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session_id');
  if (sessionId) {
    // sessionStorageから分析データを復元（決済前に保存したもの）
    try {
      var savedAnalysis = sessionStorage.getItem('ai_shoken_pendingAnalysis');
      var savedArea = sessionStorage.getItem('ai_shoken_pendingArea');
      if (savedAnalysis && savedArea) {
        analysisData = JSON.parse(savedAnalysis);
        currentArea = JSON.parse(savedArea);
      }
    } catch (e) { /* ignore */ }
    // 認証完了を待ってからverifyPurchaseを実行（CRITICAL-02修正）
    _pendingVerifySessionId = sessionId;
    // URLをクリーンアップ
    window.history.replaceState({}, '', window.location.pathname);
  }

  // オートコンプリート初期化
  initAutocomplete();

  // Supabase認証初期化
  initSupabase();
})();

// ---- Autocomplete ----
function initAutocomplete() {
  var input = document.getElementById('area-input');
  var dropdown = document.getElementById('autocomplete-dropdown');
  var selectedIdx = -1;
  var currentItems = [];

  input.addEventListener('input', function() {
    if (input.disabled) return;
    var query = input.value.trim();
    if (query.length < 1) {
      dropdown.style.display = 'none';
      return;
    }

    currentItems = searchArea(query);
    selectedIdx = -1;

    if (currentItems.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    dropdown.innerHTML = '';
    currentItems.forEach(function(area, idx) {
      var item = document.createElement('div');
      item.className = 'autocomplete-item';
      var highlighted = highlightMatch(area.fullLabel, query);
      item.innerHTML = '<span class="autocomplete-item__icon">' + (area.type === 'prefecture' ? '🗾' : '📍') + '</span>' +
        '<div><div class="autocomplete-item__name">' + highlighted + '</div>' +
        '<div class="autocomplete-item__type">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        selectItem(area);
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  });

  input.addEventListener('keydown', function(e) {
    if (dropdown.style.display !== 'block' || currentItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
      highlightItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, -1);
      highlightItem();
    } else if (e.key === 'Enter') {
      if (selectedIdx >= 0 && selectedIdx < currentItems.length) {
        e.preventDefault();
        selectItem(currentItems[selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });

  input.addEventListener('blur', function() {
    setTimeout(function() { dropdown.style.display = 'none'; }, 150);
  });

  function highlightItem() {
    var items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach(function(el, i) {
      el.classList.toggle('is-selected', i === selectedIdx);
    });
  }

  function selectItem(area) {
    input.value = area.fullLabel;
    dropdown.style.display = 'none';
    // ボタン押下で分析開始に統一（即時分析しない）
  }
}

// ---- Supabase Auth ----
var _pendingCheckout = false;

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'implicit' }
    });
    // onAuthStateChangeのみで管理（INITIAL_SESSIONイベントで初期セッションも通知される）
    supabaseClient.auth.onAuthStateChange(function(event, session) {
      currentUser = session ? session.user : null;
      updateAuthUI();
      // ログイン完了後にGoogleリダイレクトやログインモーダルを処理
      if (event === 'SIGNED_IN') {
        var modal = document.getElementById('login-modal');
        if (modal && modal.classList.contains('active')) {
          modal.classList.remove('active');
        }
        // ログイン後に購入フローを自動再開
        if (_pendingCheckout && currentArea) {
          _pendingCheckout = false;
          _doCheckout();
        }
      }
      // パスワードリセットリンクからのリダイレクト検知
      if (event === 'PASSWORD_RECOVERY') {
        var newPass = prompt('新しいパスワードを入力してください（6文字以上）');
        if (newPass && newPass.length >= 6) {
          supabaseClient.auth.updateUser({ password: newPass }).then(function(res) {
            if (res.error) alert('パスワード変更エラー: ' + res.error.message);
            else alert('パスワードを変更しました。ログイン済みです。');
          });
        }
      }
      // 認証完了後にStripe決済戻りの購入確認を実行（CRITICAL-02修正）
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && _pendingVerifySessionId) {
        // INITIAL_SESSION で未ログイン → ログインを促す
        if (event === 'INITIAL_SESSION' && !session) {
          showLoginModal();
          return;
        }
        var sid = _pendingVerifySessionId;
        _pendingVerifySessionId = null;
        verifyPurchase(sid);
      }
    });
  } else {
    console.warn('[Auth] Supabase SDK not loaded');
  }
}

function updateAuthUI() {
  var authArea = document.getElementById('auth-area');
  if (!authArea) return;
  if (currentUser) {
    var email = currentUser.email || '';
    var displayName = email.split('@')[0];
    authArea.innerHTML = '<span class="auth-user">\uD83D\uDC64 ' + escapeHtml(displayName) + '</span>' +
      '<button class="header__history-btn" onclick="showHistoryModal()">📋 履歴</button>' +
      '<button class="auth-logout-btn" onclick="logoutUser()">ログアウト</button>';
  } else {
    authArea.innerHTML = '<button class="auth-login-btn" onclick="showLoginModal()">🔑 ログイン</button>';
  }
}

function showLoginModal() {
  document.getElementById('login-modal').classList.add('active');
  // デフォルトはログインモード
  switchAuthMode('login');
}

function switchAuthMode(mode) {
  var isLogin = (mode === 'login');
  document.getElementById('auth-mode-title').textContent = isLogin ? 'ログイン' : '新規登録';
  document.getElementById('auth-submit-btn').textContent = isLogin ? 'ログイン' : '登録する';
  document.getElementById('auth-switch-text').innerHTML = isLogin ?
    'アカウントをお持ちでない方は <a href="#" onclick="switchAuthMode(\'signup\'); return false;">新規登録</a>' :
    'すでにアカウントをお持ちの方は <a href="#" onclick="switchAuthMode(\'login\'); return false;">ログイン</a>';
  document.getElementById('auth-error').textContent = '';
  // パスワードリセットモードからの復帰
  document.getElementById('auth-password').style.display = '';
  var forgotEl = document.getElementById('auth-forgot');
  if (forgotEl) forgotEl.style.display = isLogin ? '' : 'none';
  // 現在のモードをdata属性に保持
  document.getElementById('auth-form').dataset.mode = mode;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) { alert('認証システムを初期化中です。少々お待ちください。'); return; }

  var email = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;
  var errorEl = document.getElementById('auth-error');
  var submitBtn = document.getElementById('auth-submit-btn');
  var mode = document.getElementById('auth-form').dataset.mode || 'login';

  if (!email || !password) { errorEl.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (password.length < 6) { errorEl.textContent = 'パスワードは6文字以上で入力してください'; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = '処理中...';
  errorEl.textContent = '';

  try {
    var result;
    if (mode === 'reset') {
      // パスワードリセットメール送信
      result = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (result.error) throw result.error;
      errorEl.style.color = '#10b981';
      errorEl.textContent = 'リセットメールを送信しました。メールのリンクからパスワードを再設定してください。';
      return;
    } else if (mode === 'login') {
      result = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
    } else {
      result = await supabaseClient.auth.signUp({ email: email, password: password });
    }

    if (result.error) throw result.error;

    // 成功 → モーダルを閉じる
    document.getElementById('login-modal').classList.remove('active');
    document.getElementById('auth-form').reset();

  } catch (err) {
    var msg = err.message || '認証エラーが発生しました';
    // よくあるエラーメッセージを日本語化
    if (msg.includes('Invalid login')) msg = 'メールアドレスまたはパスワードが正しくありません';
    if (msg.includes('already registered')) msg = 'このメールアドレスは既に登録されています';
    if (msg.includes('Email not confirmed')) msg = 'メールアドレスが未確認です';
    errorEl.style.color = '';
    errorEl.textContent = msg;
  } finally {
    submitBtn.disabled = false;
    if (mode === 'reset') submitBtn.textContent = 'リセットメールを送信';
    else submitBtn.textContent = (mode === 'login') ? 'ログイン' : '登録する';
  }
}

async function loginWithGoogle() {
  if (!supabaseClient) return;
  var currentUrl = window.location.origin + window.location.pathname;
  // hashやqueryを除いたクリーンなURLを渡す
  var result = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: currentUrl }
  });
  if (result.error) {
    document.getElementById('auth-error').textContent = result.error.message || 'Googleログインエラー';
  }
}

async function logoutUser() {
  if (!supabaseClient) return;
  // signOut()がonAuthStateChangeをトリガーし、currentUser=null + updateAuthUI()が自動実行される
  await supabaseClient.auth.signOut();
}

function showPasswordReset() {
  document.getElementById('auth-mode-title').textContent = 'パスワードリセット';
  document.getElementById('auth-password').style.display = 'none';
  document.getElementById('auth-submit-btn').textContent = 'リセットメールを送信';
  document.getElementById('auth-forgot').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-form').dataset.mode = 'reset';
  document.getElementById('auth-switch-text').innerHTML =
    '<a href="#" onclick="switchAuthMode(\'login\'); return false;">ログインに戻る</a>';
}


// ---- Gemini API via Worker Proxy ----
var _lastGeminiCall = 0;
var _geminiMinInterval = 6000;

async function callGemini(prompt) {
  var now = Date.now();
  var elapsed = now - _lastGeminiCall;
  if (_lastGeminiCall > 0 && elapsed < _geminiMinInterval) {
    var waitMs = _geminiMinInterval - elapsed;
    addLog('  ⏳ API間隔調整 ' + Math.ceil(waitMs/1000) + '秒...', 'info');
    await new Promise(function(r) { setTimeout(r, waitMs); });
  }
  _lastGeminiCall = Date.now();

  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(WORKER_BASE + '/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });

    if (res.status === 429 && attempt < maxRetries) {
      var waitSec = 10 * (attempt + 1);
      addLog('  API制限検知、' + waitSec + '秒後にリトライ... (' + (attempt + 1) + '/' + maxRetries + ')', 'info');
      await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
      _lastGeminiCall = Date.now();
      continue;
    }

    var data = await res.json();
    if (!res.ok) {
      var errMessage = (data.error && typeof data.error === 'string') ? data.error : (data.error && data.error.message) || ('API Error: ' + res.status);
      throw new Error(errMessage);
    }
    return data.text || '';
  }
  // リトライ上限に達した場合
  throw new Error('AI APIが混雑しています。しばらくしてから再度お試しください。');
}

// ---- e-Stat API via Worker Proxy ----
async function fetchEstatPopulation(prefecture, city) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;

  addLog('政府統計APIから人口データを取得中...', 'info');
  try {
    var url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '000&limit=100';
    var res = await fetch(url);
    if (!res.ok) throw new Error('e-Stat API HTTP ' + res.status);
    var data = await res.json();

    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '&limit=100';
      res = await fetch(url);
      data = await res.json();
      result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    }

    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      addLog('該当データがありません。AI推計に切り替えます。', 'info');
      return null;
    }

    var values = result.DATA_INF.VALUE;
    var population = null;
    var households = null;

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val)) continue;
      if (v['@tab'] === '020' || (v['@cat01'] && v['@cat01'].indexOf('0010') >= 0)) {
        if (!population || val > 100) population = val;
      }
      if (v['@tab'] === '040' || (v['@cat01'] && v['@cat01'].indexOf('0020') >= 0)) {
        if (!households || val > 100) households = val;
      }
    }

    if (population) {
      addLog('人口データ取得成功 (' + formatNumber(population) + '人)', 'success');
      return { total_population: population, households: households || Math.round(population / 2.3), source: 'e-Stat 国勢調査', from_estat: true };
    }
    return null;
  } catch (e) {
    console.warn('[e-Stat] Error:', e);
    addLog('統計API接続エラー: ' + e.message + '。AI推計に切り替えます。', 'info');
    return null;
  }
}

// ---- Logging ----
function addLog(message, type) {
  var div = document.createElement('div');
  div.className = 'log-item' + (type ? ' log-item--' + type : '');
  div.textContent = message;
  progressLogContent.appendChild(div);
  progressLogContent.scrollTop = progressLogContent.scrollHeight;
}

function clearLogs() {
  progressLogContent.innerHTML = '';
}

// ---- Analysis Flow ----
async function startAnalysis() {
  var input = areaInput.value.trim();
  if (!input) { showError('エリア名を入力してください'); return; }

  hideError();
  var candidates = searchArea(input);

  if (candidates.length === 0) {
    showError('「' + input + '」に一致するエリアが見つかりません。都道府県名や市区町村名を入力してください。');
    return;
  }

  if (candidates.length === 1) {
    runAreaAnalysis(candidates[0]);
    return;
  }

  // 複数候補 → 選択モーダル
  showAreaSelectModal(candidates);
}

function showAreaSelectModal(candidates) {
  var listEl = document.getElementById('area-select-list');
  listEl.innerHTML = '';

  candidates.forEach(function(area) {
    var btn = document.createElement('button');
    btn.className = 'area-select-btn';
    btn.innerHTML = '<span style="font-size:20px;">📍</span>' +
      '<div><div style="font-weight:700;">' + escapeHtml(area.fullLabel) + '</div>' +
      '<div style="font-size:11px; color:var(--text-muted);">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';

    btn.addEventListener('click', function() {
      document.getElementById('area-select-modal').classList.remove('active');
      runAreaAnalysis(area);
    });
    listEl.appendChild(btn);
  });

  document.getElementById('area-select-modal').classList.add('active');
}

// ---- Main Analysis ----
async function runAreaAnalysis(area) {
  if (_analysisRunning) return;
  _analysisRunning = true;
  currentArea = area;

  // 購入チェック・DB読み込みを全体try-catchで囲み、_analysisRunningが確実にリセットされるよう保護
  try {
    isPurchased = await isAreaPurchasedAsync(area.fullLabel);

    // 購入済みかつDBにデータがあれば即表示（再分析不要）
    if (isPurchased && currentUser) {
      var dbData = await _loadAnalysisDataFromDB(area.fullLabel);
      if (dbData) {
        analysisData = dbData;
        document.getElementById('purchase-prompt').style.display = 'none';
        renderResults(analysisData, true);
        showResults();
        _analysisRunning = false;
        return;
      }
    }
  } catch (preErr) {
    // 購入チェック失敗は致命的でないのでisAreaPurchased=falseとして続行
    isPurchased = isAreaPurchased(area.fullLabel);
  }

  hideError();
  hideResults();
  showProgress();
  setLoading(true);
  clearLogs();

  addLog('🏪 出店商圏分析を開始します...', 'info');
  addLog('対象エリア: ' + area.fullLabel, 'info');

  try {
    // Step 1: 統計データ取得
    activateStep('step-data');

    addLog('  政府統計APIから人口データを取得中...', 'info');
    var estatPop = await fetchEstatPopulation(area.prefecture, area.city);

    completeStep('step-data');

    // Step 2: AI商圏分析
    activateStep('step-ai');
    addLog('AIが商圏データを分析中...', 'info');

    var shokenPrompt = buildShokenPrompt(area, estatPop);
    var shokenRaw = await callGemini(shokenPrompt);
    var marketData = parseJSON(shokenRaw);

    // e-Stat実データで上書き
    if (estatPop && estatPop.from_estat) {
      if (!marketData.population) marketData.population = {};
      marketData.population.total_population = estatPop.total_population;
      marketData.population.households = estatPop.households;
      marketData.population.source = estatPop.source;
    }

    addLog('→ ' + area.fullLabel + ' 分析完了', 'success');
    completeStep('step-ai');

    // Step 3: レポート生成
    activateStep('step-report');
    addLog('レポート生成中...', 'info');

    analysisData = {
      area: area,
      shoken: marketData,
      timestamp: new Date().toISOString(),
      data_source: '政府統計 + AI'
    };

    renderResults(analysisData, isPurchased);
    completeStep('step-report');
    addLog('✅ 商圏分析完了！', 'success');

    hideProgress();
    showResults();

    // 購入済みエリアなら分析データをDBにも保存（履歴から再分析不要にする）
    if (isPurchased && currentUser) {
      _saveAnalysisDataToDB(area.fullLabel, analysisData);
    }

  } catch (err) {
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally {
    setLoading(false);
    _analysisRunning = false;
  }
}

// ---- Build Shoken Prompt ----
function buildShokenPrompt(area, estatPop) {
  var pref = area.prefecture || '不明';
  var city = area.city || '';
  var estatInfo = '';
  if (estatPop && estatPop.total_population) {
    estatInfo = '\n\n【参考: 政府統計実データ（国勢調査）】\n' +
      '・総人口: ' + formatNumber(estatPop.total_population) + '人\n' +
      '・世帯数: ' + formatNumber(estatPop.households) + '世帯\n' +
      'これらの実データを基準にして、他の項目も整合性のある値を推定してください。\n';
  }

  return 'あなたは日本の商圏分析・出店戦略の専門家です。\n' +
    '以下の地域について、出店・開業を検討する人向けの商圏データを提供してください。\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    estatInfo + '\n' +
    'できる限り正確な数値を提供してください。正確な数値が不明な場合は、合理的な推計値を提供し、sourceフィールドに「推計」と明記してください。\n\n' +
    '重要ルール:\n' +
    '・avg_household_income, disposable_income は万円単位の数値で返してください\n' +
    '・monthly_expenditure は万円/月の数値で返してください\n' +
    '・consumer_spending の各項目は円/月の数値で返してください\n' +
    '・人口・世帯数は実数（人・世帯）で返してください\n' +
    '・パーセンテージは数値のみ（例: 25.3）で返してください\n' +
    '・shoken_summary は1000文字程度の日本語テキストで、商圏の特徴・出店メリット/デメリット・推奨業種を具体的に記述してください\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋なJSONのみ返してください:\n' +
    JSON.stringify({
      area_name: pref + ' ' + city,
      shoken_summary: '（商圏の特徴・出店メリット/デメリット・推奨業種を1000文字程度で記述）',
      population: {
        total_population: 0, households: 0, population_density: 0,
        growth_rate: '+0.0%',
        source: 'データソース名'
      },
      age_composition: {
        under_20_pct: 0, age_20_34_pct: 0, age_35_49_pct: 0,
        age_50_64_pct: 0, over_65_pct: 0,
        primary_target: 'メインターゲット層の説明',
        secondary_target: 'サブターゲット層の説明'
      },
      business_establishments: {
        total: 0, retail: 0, food_service: 0, services: 0, medical: 0,
        establishments_per_1000: 0,
        year: '2024', source: '経済センサスまたは推計'
      },
      competition_density: {
        retail_density: 0, food_density: 0, service_density: 0,
        saturation_index: 0, saturation_level: '低/中/高/飽和',
        top_chains: ['チェーン名1', 'チェーン名2', 'チェーン名3'],
        opportunity_sectors: ['参入余地のある業種1', '参入余地のある業種2']
      },
      daytime_population: {
        daytime_pop: 0, nighttime_pop: 0, daytime_ratio: 0,
        commuter_inflow: 0, commuter_outflow: 0,
        worker_density: 0, note: 'daytime_ratioは昼夜間人口比率（100以上=流入超過）'
      },
      spending_power: {
        avg_household_income: 0, disposable_income: 0,
        monthly_expenditure: 0,
        retail_spending_index: 0, food_spending_index: 0,
        service_spending_index: 0,
        engel_coefficient: 0, eating_out_rate: 0,
        note: 'income系は万円/年、monthly_expenditureは万円/月、index系は全国平均=100、coefficient/rateは%'
      },
      consumer_spending: {
        food_total: 0, eating_out: 0, housing: 0, utilities: 0,
        clothing: 0, medical: 0, transportation: 0, education: 0,
        entertainment: 0, communication: 0, personal_care: 0,
        social_expenses: 0, total_monthly: 0,
        note: '全て円/月・世帯平均。家計調査ベースの推計値'
      },
      location_score: {
        overall_score: 0, traffic_score: 0, population_score: 0,
        competition_score: 0, spending_score: 0, growth_score: 0,
        grade: 'S/A/B/C/D',
        ai_recommendation: '出店に関するAI総合判定コメント（100文字程度）'
      },
      marketing_channels: {
        channels: [
          { name: 'SNS広告', score: 0, platforms: 'Instagram, LINE', reason: '理由' },
          { name: 'リスティング広告', score: 0, platforms: 'Google Ads', reason: '理由' },
          { name: 'チラシ・ポスティング', score: 0, platforms: '地域配布', reason: '理由' },
          { name: '看板・OOH', score: 0, platforms: '駅前広告', reason: '理由' }
        ],
        best_channel: '最も推奨するチャネル名',
        strategy_summary: '集客戦略の提言（200文字程度）'
      }
    }, null, 2);
}

// ---- JSON Parser ----
function parseJSON(text) {
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    throw new Error('AIの応答をパースできませんでした。再度お試しください。');
  }
}

// ---- Render Results ----
function renderResults(data, purchased) {
  var m = data.shoken;
  var area = data.area;
  var html = '';

  var sourceBadge = '<span style="background: linear-gradient(135deg, #10b981, #3b82f6); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 実データ + AI分析</span>';

  // エリア情報カード
  html += '<div class="result-card result-card--company">' +
    '<div class="result-card__header">' +
    '<div class="result-card__icon">🏪</div>' +
    '<div>' +
    '<div class="result-card__title">' + escapeHtml(area.fullLabel) + ' 出店商圏分析</div>' +
    '<div class="result-card__subtitle">AI出店商圏レポート ' + sourceBadge + '</div>' +
    '</div></div>' +
    '<div class="result-card__body">' +
    '<table class="data-table">' +
    '<tr><th>分析対象</th><td>' + escapeHtml(area.fullLabel) + '</td></tr>' +
    '<tr><th>分析日時</th><td>' + new Date().toLocaleString('ja-JP') + '</td></tr>' +
    '</table>' +
    '</div></div>';

  // ① 人口・世帯（無料プレビュー）
  if (m.population) {
    var pop = m.population;
    var popSource = pop.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(pop.source) + ')</span>' : '';
    html += '<div class="result-card" data-section="free">' +
      '<div class="result-card__header"><div class="result-card__icon">👥</div>' +
      '<div><div class="result-card__title">① エリア人口・世帯' + popSource + '</div>' +
      '<div class="result-card__subtitle"><span class="badge-free">無料プレビュー</span></div></div></div>' +
      '<div class="result-card__body">' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.total_population) + '</div><div class="stat-box__label">総人口（人）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.households) + '</div><div class="stat-box__label">世帯数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.population_density ? formatNumber(pop.population_density) : '—') + '</div><div class="stat-box__label">人口密度（人/km²）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.growth_rate || '—') + '</div><div class="stat-box__label">人口増減率</div></div>' +
      '</div></div></div>';
  }

  // 有料セクション共通設定
  var paidClass = purchased ? '' : ' blurred-section';
  var paidOverlay = purchased ? '' : '<div class="blur-overlay"><div class="blur-overlay__inner"><span class="blur-overlay__icon">🔒</span><span>購入すると表示されます</span></div></div>';

  // ② AI商圏分析（有料）
  if (m.shoken_summary) {
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🤖</div>' +
      '<div><div class="result-card__title">② AI商圏分析</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="market-summary">' + escapeHtml(m.shoken_summary).replace(/\n/g, '<br>') + '</div>' +
      '</div></div>';
  }

  // ③ 年齢構成・ターゲット層（有料）
  if (m.age_composition) {
    var ac = m.age_composition;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">👨‍👩‍👧‍👦</div>' +
      '<div><div class="result-card__title">③ 年齢構成・ターゲット層</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    // 年齢帯別割合バー
    var u20 = ac.under_20_pct || 0;
    var a2034 = ac.age_20_34_pct || 0;
    var a3549 = ac.age_35_49_pct || 0;
    var a5064 = ac.age_50_64_pct || 0;
    var o65 = ac.over_65_pct || 0;
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">年齢構成</div>' +
      '<div style="display:flex; height:24px; border-radius:8px; overflow:hidden; font-size:10px; font-weight:700;">' +
      '<div style="width:' + u20 + '%; background:#818cf8; display:flex; align-items:center; justify-content:center; color:#fff;">' + (u20 >= 10 ? u20 + '%' : '') + '</div>' +
      '<div style="width:' + a2034 + '%; background:#10b981; display:flex; align-items:center; justify-content:center; color:#fff;">' + (a2034 >= 10 ? a2034 + '%' : '') + '</div>' +
      '<div style="width:' + a3549 + '%; background:#3b82f6; display:flex; align-items:center; justify-content:center; color:#fff;">' + (a3549 >= 10 ? a3549 + '%' : '') + '</div>' +
      '<div style="width:' + a5064 + '%; background:#f59e0b; display:flex; align-items:center; justify-content:center; color:#fff;">' + (a5064 >= 10 ? a5064 + '%' : '') + '</div>' +
      '<div style="width:' + o65 + '%; background:#ef4444; display:flex; align-items:center; justify-content:center; color:#fff;">' + (o65 >= 10 ? o65 + '%' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex; gap:10px; margin-top:4px; font-size:10px; color:var(--text-muted); flex-wrap:wrap;">' +
      '<span>🟣 20歳未満 ' + u20 + '%</span><span>🟢 20-34歳 ' + a2034 + '%</span>' +
      '<span>🔵 35-49歳 ' + a3549 + '%</span><span>🟡 50-64歳 ' + a5064 + '%</span><span>🔴 65歳以上 ' + o65 + '%</span></div></div>';

    if (ac.primary_target) {
      html += '<div class="summary-box" style="margin-top:8px;">' +
        '<div class="summary-box__title">🎯 メインターゲット</div>' +
        '<div class="summary-box__text">' + escapeHtml(ac.primary_target) + '</div></div>';
    }
    if (ac.secondary_target) {
      html += '<div class="summary-box" style="margin-top:8px;">' +
        '<div class="summary-box__title">🎯 サブターゲット</div>' +
        '<div class="summary-box__text">' + escapeHtml(ac.secondary_target) + '</div></div>';
    }
    html += '</div></div>';
  }

  // ④ 事業所・企業統計（有料）
  if (m.business_establishments) {
    var be = m.business_establishments;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏢</div>' +
      '<div><div class="result-card__title">④ 事業所・企業統計</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + (be.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(be.source) + ')</span>' : '') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.total) + '</div><div class="stat-box__label">総事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.retail) + '</div><div class="stat-box__label">小売業</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.food_service) + '</div><div class="stat-box__label">飲食業</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.services) + '</div><div class="stat-box__label">サービス業</div></div>' +
      '</div>' +
      '<table class="data-table" style="margin-top:8px;">' +
      '<tr><th>医療・福祉</th><td>' + formatNumber(be.medical) + ' 事業所</td></tr>' +
      '<tr><th>人口1000人あたり事業所数</th><td><span class="highlight">' + (be.establishments_per_1000 || '—') + '</span></td></tr>' +
      '</table>' +
      '</div></div>';
  }

  // ⑤ 業種別競合密度（有料）
  if (m.competition_density) {
    var cd = m.competition_density;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">📊</div>' +
      '<div><div class="result-card__title">⑤ 業種別競合密度</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + (cd.retail_density || '—') + '</div><div class="stat-box__label">小売密度（店/km²）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (cd.food_density || '—') + '</div><div class="stat-box__label">飲食密度（店/km²）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (cd.service_density || '—') + '</div><div class="stat-box__label">サービス密度</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (cd.saturation_index || '—') + '</div><div class="stat-box__label">飽和度指数</div></div>' +
      '</div>' +
      '<table class="data-table" style="margin-top:8px;">' +
      '<tr><th>飽和レベル</th><td><span class="highlight">' + escapeHtml(cd.saturation_level || '—') + '</span></td></tr>' +
      '</table>';

    if (cd.top_chains && cd.top_chains.length > 0) {
      html += '<div style="margin-top:12px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">主要競合チェーン</div>';
      html += '<div class="tag-list">';
      cd.top_chains.forEach(function(chain) {
        html += '<span class="tag">🏪 ' + escapeHtml(chain) + '</span>';
      });
      html += '</div></div>';
    }

    if (cd.opportunity_sectors && cd.opportunity_sectors.length > 0) {
      html += '<div style="margin-top:12px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">参入余地のある業種</div>';
      html += '<div class="tag-list">';
      cd.opportunity_sectors.forEach(function(sector) {
        html += '<span class="tag" style="border-color:rgba(16,185,129,0.3); color:#10b981;">✅ ' + escapeHtml(sector) + '</span>';
      });
      html += '</div></div>';
    }

    html += '</div></div>';
  }

  // ⑥ 昼間人口・従業者密度（有料）
  if (m.daytime_population) {
    var dp = m.daytime_population;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🌇</div>' +
      '<div><div class="result-card__title">⑥ 昼間人口・従業者密度</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dp.daytime_pop) + '</div><div class="stat-box__label">昼間人口（人）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dp.nighttime_pop) + '</div><div class="stat-box__label">夜間人口（人）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (dp.daytime_ratio || '—') + '</div><div class="stat-box__label">昼夜間比率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (dp.worker_density || '—') + '</div><div class="stat-box__label">従業者密度</div></div>' +
      '</div>' +
      '<table class="data-table" style="margin-top:8px;">' +
      '<tr><th>流入通勤者数</th><td>' + formatNumber(dp.commuter_inflow) + ' 人</td></tr>' +
      '<tr><th>流出通勤者数</th><td>' + formatNumber(dp.commuter_outflow) + ' 人</td></tr>' +
      '</table>' +
      '</div></div>';
  }

  // ⑦ 消費力指数（有料）
  if (m.spending_power) {
    var sp = m.spending_power;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">💰</div>' +
      '<div><div class="result-card__title">⑦ 消費力指数</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.avg_household_income ? formatNumber(toMan(sp.avg_household_income)) + '万' : '—') + '</div><div class="stat-box__label">平均世帯年収</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.disposable_income ? formatNumber(toMan(sp.disposable_income)) + '万' : '—') + '</div><div class="stat-box__label">可処分所得</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.monthly_expenditure ? formatNumber(toMan(sp.monthly_expenditure)) + '万' : '—') + '</div><div class="stat-box__label">月間消費支出</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.engel_coefficient ? sp.engel_coefficient + '%' : '—') + '</div><div class="stat-box__label">エンゲル係数</div></div>' +
      '</div>' +
      '<div class="stat-grid" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.retail_spending_index || '—') + '</div><div class="stat-box__label">小売消費指数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.food_spending_index || '—') + '</div><div class="stat-box__label">飲食消費指数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.service_spending_index || '—') + '</div><div class="stat-box__label">サービス消費指数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sp.eating_out_rate ? sp.eating_out_rate + '%' : '—') + '</div><div class="stat-box__label">外食率</div></div>' +
      '</div>' +
      '<p style="font-size:11px; color:var(--text-muted); margin-top:8px;">※消費指数は全国平均=100 / エンゲル係数=食費÷消費支出×100</p>' +
      '</div></div>';
  }

  // ⑧ 消費支出内訳（有料・新規）
  if (m.consumer_spending) {
    var cs = m.consumer_spending;
    var spendItems = [
      { key: 'food_total', label: '食料費', color: '#f97316' },
      { key: 'eating_out', label: '外食費', color: '#fb923c' },
      { key: 'housing', label: '住居費', color: '#3b82f6' },
      { key: 'utilities', label: '光熱・水道', color: '#60a5fa' },
      { key: 'transportation', label: '交通費', color: '#8b5cf6' },
      { key: 'communication', label: '通信費', color: '#a78bfa' },
      { key: 'education', label: '教育費', color: '#ec4899' },
      { key: 'entertainment', label: '教養娯楽費', color: '#f472b6' },
      { key: 'medical', label: '医療費', color: '#14b8a6' },
      { key: 'clothing', label: '被服費', color: '#2dd4bf' },
      { key: 'personal_care', label: '理美容費', color: '#a3a3a3' },
      { key: 'social_expenses', label: '交際費', color: '#78716c' }
    ];
    var maxVal = 0;
    spendItems.forEach(function(it) { if ((cs[it.key] || 0) > maxVal) maxVal = cs[it.key]; });
    if (maxVal === 0) maxVal = 1;

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🛒</div>' +
      '<div><div class="result-card__title">⑧ 消費支出内訳</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    if (cs.total_monthly) {
      html += '<div style="text-align:center; margin-bottom:16px;">' +
        '<div style="font-size:11px; color:var(--text-muted);">世帯あたり月間消費支出</div>' +
        '<div style="font-size:32px; font-weight:900; color:#10b981;">¥' + formatNumber(cs.total_monthly) + '<span style="font-size:14px; font-weight:400; color:var(--text-muted);">/月</span></div>' +
        '</div>';
    }

    html += '<div style="display:flex; flex-direction:column; gap:6px;">';
    spendItems.forEach(function(it) {
      var val = cs[it.key] || 0;
      var pct = maxVal > 0 ? Math.round(val / maxVal * 100) : 0;
      html += '<div style="display:flex; align-items:center; gap:8px;">' +
        '<div style="width:80px; font-size:11px; color:var(--text-secondary); text-align:right;">' + it.label + '</div>' +
        '<div style="flex:1; height:20px; background:rgba(255,255,255,0.05); border-radius:4px; overflow:hidden;">' +
        '<div style="height:100%; width:' + pct + '%; background:' + it.color + '; border-radius:4px; transition:width 0.5s;"></div>' +
        '</div>' +
        '<div style="width:70px; font-size:12px; font-weight:600; color:var(--text-primary); text-align:right;">¥' + formatNumber(val) + '</div>' +
        '</div>';
    });
    html += '</div>';

    html += '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">※世帯平均月額（家計調査ベース推計値）</p>' +
      '</div></div>';
  }

  // ⑨ 出店適性スコア（有料）
  if (m.location_score) {
    var ls = m.location_score;
    var gradeColor = { S: '#10b981', A: '#3b82f6', B: '#f59e0b', C: '#f97316', D: '#ef4444' };
    var gc = gradeColor[ls.grade] || '#94a3b8';
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🎯</div>' +
      '<div><div class="result-card__title">⑨ 出店適性スコア</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div style="text-align:center; margin-bottom:16px;">' +
      '<div style="font-size:60px; font-weight:900; color:' + gc + '; line-height:1;">' + (ls.overall_score || '—') + '</div>' +
      '<div style="font-size:14px; color:var(--text-muted);">/ 100点</div>' +
      '<div style="font-size:32px; font-weight:900; color:' + gc + '; margin-top:4px;">グレード ' + escapeHtml(ls.grade || '—') + '</div>' +
      '</div>' +
      '<table class="data-table">' +
      '<tr><th>交通・立地</th><td><span class="highlight">' + (ls.traffic_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>人口・世帯</th><td><span class="highlight">' + (ls.population_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>競合環境</th><td><span class="highlight">' + (ls.competition_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>消費力</th><td><span class="highlight">' + (ls.spending_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>成長性</th><td><span class="highlight">' + (ls.growth_score || '—') + '</span> 点</td></tr>' +
      '</table>';

    if (ls.ai_recommendation) {
      html += '<div class="summary-box" style="margin-top:10px;">' +
        '<div class="summary-box__title">🤖 AI総合判定</div>' +
        '<div class="summary-box__text">' + escapeHtml(ls.ai_recommendation) + '</div></div>';
    }
    html += '</div></div>';
  }

  // ⑩ 集客チャネル（有料）
  if (m.marketing_channels) {
    var mc = m.marketing_channels;
    var channels = mc.channels || [];
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">📢</div>' +
      '<div><div class="result-card__title">⑩ 集客チャネル</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    var medals = ['🥇', '🥈', '🥉'];
    var sortedCh = channels.slice().sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    html += '<div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--text-secondary);">推奨集客チャネル</div>';
    sortedCh.forEach(function(ch, idx) {
      var score = ch.score || 0;
      var isBest = (idx === 0);
      var barColor = isBest ? '#10b981' : (idx === 1 ? '#3b82f6' : '#6b7280');
      var medal = medals[idx] || '　';
      html += '<div style="margin-bottom:8px; padding:10px; border-radius:8px; background:' + (isBest ? 'rgba(16,185,129,0.1)' : 'rgba(30,41,59,0.5)') + '; border:1px solid ' + (isBest ? 'rgba(16,185,129,0.3)' : 'rgba(99,102,241,0.1)') + ';">' +
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
        '<span style="font-size:16px;">' + medal + '</span>' +
        '<span style="font-weight:700; font-size:13px; color:var(--text-primary);">' + escapeHtml(ch.name || '') + '</span>' +
        '<span style="font-size:18px; font-weight:800; color:' + barColor + '; margin-left:auto;">' + score + '<span style="font-size:11px; font-weight:400;">点</span></span>' +
        (isBest ? '<span style="background:#10b981; color:#fff; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;">推奨</span>' : '') +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; margin-bottom:4px;">' +
        '<div style="height:100%; width:' + score + '%; background:' + barColor + '; border-radius:3px;"></div></div>' +
        '<div style="font-size:11px; color:var(--text-muted);">📍 ' + escapeHtml(ch.platforms || '') + '</div>' +
        '<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">→ ' + escapeHtml(ch.reason || '') + '</div>' +
        '</div>';
    });

    if (mc.strategy_summary) {
      html += '<div class="summary-box" style="margin-top:10px"><div class="summary-box__title">💡 集客戦略の提言</div><div class="summary-box__text">' + escapeHtml(mc.strategy_summary) + '</div></div>';
    }
    html += '</div></div>';
  }

  resultsContent.innerHTML = html;

  // 未購入なら購入プロンプトを表示
  if (!purchased) {
    document.getElementById('purchase-prompt').style.display = 'flex';
  } else {
    document.getElementById('purchase-prompt').style.display = 'none';
    hidePurchaseFloat();
  }
}

// ---- Stripe Checkout ----
function startCheckout() {
  if (!currentArea) return;

  // 未ログインなら先にログインを促す（ログイン後に自動で _doCheckout を実行）
  if (!currentUser) {
    _pendingCheckout = true;
    showLoginModal();
    return;
  }

  _doCheckout();
}

async function _doCheckout() {
  if (!currentArea || !currentUser) return;

  // 決済リダイレクト前に分析データを保存（戻ってきた時に復元するため）
  if (analysisData) {
    try {
      var serialized = JSON.stringify(analysisData);
      sessionStorage.setItem('ai_shoken_pendingAnalysis', serialized);
      sessionStorage.setItem('ai_shoken_pendingArea', JSON.stringify(currentArea));
    } catch (e) {
      console.error('[Checkout] sessionStorage保存失敗:', e);
      if (!confirm('分析データの一時保存に失敗しました。決済後は履歴からレポートを再表示できます。続行しますか？')) {
        return;
      }
    }
  }

  var btn = document.getElementById('purchase-btn');
  btn.disabled = true;
  btn.textContent = '処理中...';

  try {
    // セッションからJWTを取得（Worker側でuser_idを検証する）
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) throw new Error('認証トークンが取得できません。再ログインしてください。');

    var res = await fetch(WORKER_BASE + '/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        area: currentArea.fullLabel,
        area_code: currentArea.code || '',
        service: 'ai-shoken',
        success_url: window.location.origin + window.location.pathname + '?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: window.location.origin + window.location.pathname
      })
    });

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout作成エラー');

    // Stripe CheckoutページへリダイレクトWorkerが返すURLを直接使用）
    if (!data.url) throw new Error('Checkout URLが取得できませんでした');
    window.location.href = data.url;

  } catch (err) {
    alert('決済エラー: ' + err.message);
    btn.disabled = false;
    btn.textContent = '💳 購入してレポートを見る';
  }
}

async function verifyPurchase(sessionId) {
  try {
    // JWTを取得してAuthorizationヘッダーに付与
    var headers = {};
    if (supabaseClient && currentUser) {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    var res = await fetch(WORKER_BASE + '/api/purchases?session_id=' + encodeURIComponent(sessionId), { headers: headers });
    var data = await res.json();
    if (data.purchased) {
      // 購入情報をローカルに保存
      savePurchase(data.area, sessionId);
      isPurchased = true;

      // 分析データがあれば購入プロンプトを消して全データ表示
      if (analysisData && analysisData.area) {
        document.getElementById('purchase-prompt').style.display = 'none';
        renderResults(analysisData, true);
        showResults();

        // 領収書メール案内（購入直後のみ表示）
        var receiptNote = document.createElement('div');
        receiptNote.style.cssText = 'text-align:center; padding:8px; margin:8px 0; background:rgba(16,185,129,0.1); border-radius:8px; font-size:13px; color:#10b981;';
        receiptNote.textContent = '購入ありがとうございます。領収書はご登録メールアドレスに送信されます。';
        var resultsHeader = document.querySelector('.results__header');
        if (resultsHeader) resultsHeader.after(receiptNote);

        // 分析データをDBに保存
        _saveAnalysisDataToDB(data.area, analysisData);
      }

      // sessionStorageクリア
      sessionStorage.removeItem('ai_shoken_pendingAnalysis');
      sessionStorage.removeItem('ai_shoken_pendingArea');
    }
  } catch (e) {
    console.warn('Purchase verification failed:', e);
  }
}

// ---- DB Analysis Data ----
async function _saveAnalysisDataToDB(areaName, data) {
  if (!currentUser || !supabaseClient) return;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return;
    await fetch(WORKER_BASE + '/api/purchases/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ area_name: areaName, analysis_data: data, service_name: 'ai-shoken' })
    });
  } catch (e) { console.warn('Analysis data save failed:', e); }
}

async function _loadAnalysisDataFromDB(areaName) {
  if (!currentUser || !supabaseClient) return null;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return null;
    var res = await fetch(WORKER_BASE + '/api/purchases/data?area_name=' + encodeURIComponent(areaName) + '&service_name=ai-shoken', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var result = await res.json();
    if (result.found && result.analysis_data) return result.analysis_data;
  } catch (e) { /* fall through */ }
  return null;
}

// ---- Purchase History (localStorage) ----
function getPurchases() {
  try {
    return JSON.parse(localStorage.getItem('ai_shoken_purchases') || '[]');
  } catch (e) { return []; }
}

function savePurchase(areaName, sessionId) {
  var purchases = getPurchases();
  if (!purchases.some(function(p) { return p.area === areaName; })) {
    purchases.push({ area: areaName, session_id: sessionId, date: new Date().toISOString() });
    localStorage.setItem('ai_shoken_purchases', JSON.stringify(purchases));
  }
}

function isAreaPurchased(areaName) {
  return getPurchases().some(function(p) { return p.area === areaName; });
}

async function isAreaPurchasedAsync(areaName) {
  // ログイン中ならWorker API経由でDB確認
  if (currentUser && supabaseClient) {
    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) {
        var res = await fetch(WORKER_BASE + '/api/purchases/check?area_name=' + encodeURIComponent(areaName) + '&service_name=ai-shoken', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var result = await res.json();
        if (result.purchased) return true;
      }
    } catch (e) { /* fall through to localStorage */ }
  }
  // フォールバック: localStorage
  return isAreaPurchased(areaName);
}

async function showHistoryModal() {
  var listEl = document.getElementById('history-list');

  if (currentUser && supabaseClient) {
    // Worker API経由でDB購入履歴を取得
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">読み込み中...</p>';
    document.getElementById('history-modal').classList.add('active');

    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (!token) throw new Error('認証トークンなし');

      var res = await fetch(WORKER_BASE + '/api/purchases/history?service_name=ai-shoken', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || '履歴取得エラー');
      var purchases = data.purchases || [];

      if (purchases.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません</p>';
      } else {
        listEl.innerHTML = '';
        purchases.forEach(function(p) {
          var btn = document.createElement('button');
          btn.className = 'area-select-btn';
          btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
            '<div><div style="font-weight:700;">' + escapeHtml(p.area_name) + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.purchased_at).toLocaleDateString('ja-JP') + '</div></div>';
          btn.addEventListener('click', async function() {
            document.getElementById('history-modal').classList.remove('active');
            // DBから分析データを読み出し（再分析不要）
            var dbData = await _loadAnalysisDataFromDB(p.area_name);
            if (dbData) {
              analysisData = dbData;
              currentArea = dbData.area;
              isPurchased = true;
              areaInput.value = p.area_name;
              document.getElementById('purchase-prompt').style.display = 'none';
              renderResults(analysisData, true);
              showResults();
            } else {
              // DBにデータがなければ従来通り再分析
              areaInput.value = p.area_name;
              startAnalysis();
            }
          });
          listEl.appendChild(btn);
        });
      }
    } catch (err) {
      // DBエラー時はlocalStorageにフォールバック
      showHistoryFromLocalStorage(listEl);
    }
  } else {
    // 未ログイン時はlocalStorageから
    showHistoryFromLocalStorage(listEl);
    document.getElementById('history-modal').classList.add('active');
  }
}

function showHistoryFromLocalStorage(listEl) {
  var purchases = getPurchases();
  if (purchases.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません。ログインするとDB履歴を表示できます。</p>';
  } else {
    listEl.innerHTML = '';
    purchases.forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'area-select-btn';
      btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
        '<div><div style="font-weight:700;">' + escapeHtml(p.area) + '</div>' +
        '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.date).toLocaleDateString('ja-JP') + '</div></div>';
      btn.addEventListener('click', function() {
        document.getElementById('history-modal').classList.remove('active');
        areaInput.value = p.area;
        startAnalysis();
      });
      listEl.appendChild(btn);
    });
  }
}

// ---- PDF Export ----
function handlePdfDownload() {
  if (!isPurchased) {
    alert('PDFダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportPDF();
}

async function exportPDF() {
  if (!analysisData || !analysisData.shoken) { alert('分析データがありません'); return; }

  var m = analysisData.shoken;
  var area = analysisData.area;
  var dateStr = new Date().toLocaleDateString('ja-JP');

  var html = '<div style="max-width:100%; font-family:\'Noto Sans JP\',sans-serif; color:#000; background:#fff; font-size:12px; line-height:1.6; padding:0;">';

  // セクション共通スタイル
  var S = 'page-break-inside:avoid; margin-bottom:6px; border:1px solid #cbd5e1; border-radius:4px; padding:8px 12px;';
  var T = 'font-size:14px; font-weight:700; border-left:4px solid #10b981; padding-left:8px; margin-bottom:6px; color:#1e293b;';
  var TBL = 'width:100%; border-collapse:collapse; font-size:11px;';
  var TH = 'text-align:left; padding:5px 8px; background:#e2e8f0; border:1px solid #cbd5e1; font-weight:600; color:#1e293b; width:40%;';
  var TD = 'padding:5px 8px; border:1px solid #cbd5e1; color:#000;';
  var SUB = 'padding:5px 8px; background:#d1fae5; border:1px solid #6ee7b7; font-weight:700; color:#065f46;';

  function r(label, val) {
    return '<tr><th style="' + TH + '">' + escapeHtml(label) + '</th><td style="' + TD + '">' + escapeHtml(String(val || '—')) + '</td></tr>';
  }

  // ===== ヘッダー =====
  html += '<div style="text-align:center; margin-bottom:10px; padding-bottom:8px; border-bottom:3px solid #10b981;">';
  html += '<div style="font-size:22px; font-weight:800; color:#0f172a;">AI出店商圏レポート</div>';
  html += '<div style="font-size:16px; color:#10b981; font-weight:700; margin-top:4px;">' + escapeHtml(area.fullLabel) + '</div>';
  html += '<div style="font-size:9px; color:#64748b; margin-top:4px;">分析日: ' + dateStr + ' | データソース: 政府統計(e-Stat) + AI分析(Gemini)</div>';
  html += '</div>';

  // ===== 1. 人口・世帯 =====
  if (m.population) {
    var pop = m.population;
    html += '<div style="' + S + '"><div style="' + T + '">1. エリア人口・世帯データ</div>';
    html += '<table style="' + TBL + '">';
    html += r('総人口', formatNumber(pop.total_population));
    html += r('世帯数', formatNumber(pop.households));
    html += r('人口密度', (pop.population_density ? formatNumber(pop.population_density) + '人/km²' : '—'));
    html += r('人口増減率', pop.growth_rate || '—');
    if (pop.source) html += r('データソース', pop.source);
    html += '</table></div>';
  }

  // ===== AI商圏分析 =====
  if (m.shoken_summary) {
    html += '<div style="' + S + '"><div style="' + T + '">2. AI商圏分析</div>';
    html += '<div style="font-size:11px; color:#1e293b; white-space:pre-wrap; line-height:1.7; padding:4px 2px;">' + escapeHtml(m.shoken_summary) + '</div>';
    html += '</div>';
  }

  // ===== 年齢構成・ターゲット層 =====
  if (m.age_composition) {
    var ac = m.age_composition;
    html += '<div style="' + S + '"><div style="' + T + '">3. 年齢構成・ターゲット層</div>';
    html += '<table style="' + TBL + '">';
    html += r('20歳未満', (ac.under_20_pct || '—') + '%');
    html += r('20〜34歳', (ac.age_20_34_pct || '—') + '%');
    html += r('35〜49歳', (ac.age_35_49_pct || '—') + '%');
    html += r('50〜64歳', (ac.age_50_64_pct || '—') + '%');
    html += r('65歳以上', (ac.over_65_pct || '—') + '%');
    if (ac.primary_target) html += r('メインターゲット', ac.primary_target);
    if (ac.secondary_target) html += r('サブターゲット', ac.secondary_target);
    html += '</table></div>';
  }

  // ===== 事業所・企業統計 =====
  if (m.business_establishments) {
    var be = m.business_establishments;
    html += '<div style="' + S + '"><div style="' + T + '">4. 事業所・企業統計</div>';
    html += '<table style="' + TBL + '">';
    html += r('総事業所数', formatNumber(be.total));
    html += r('小売業', formatNumber(be.retail));
    html += r('飲食業', formatNumber(be.food_service));
    html += r('サービス業', formatNumber(be.services));
    html += r('医療・福祉', formatNumber(be.medical));
    html += r('人口1000人あたり', (be.establishments_per_1000 || '—'));
    html += '</table></div>';
  }

  // ===== 業種別競合密度 =====
  if (m.competition_density) {
    var cd = m.competition_density;
    html += '<div style="' + S + '"><div style="' + T + '">5. 業種別競合密度</div>';
    html += '<table style="' + TBL + '">';
    html += r('小売密度（店/km²）', cd.retail_density || '—');
    html += r('飲食密度（店/km²）', cd.food_density || '—');
    html += r('サービス密度', cd.service_density || '—');
    html += r('飽和度指数', cd.saturation_index || '—');
    html += r('飽和レベル', cd.saturation_level || '—');
    if (cd.top_chains && cd.top_chains.length > 0) {
      html += r('主要競合チェーン', cd.top_chains.join(', '));
    }
    if (cd.opportunity_sectors && cd.opportunity_sectors.length > 0) {
      html += r('参入余地のある業種', cd.opportunity_sectors.join(', '));
    }
    html += '</table></div>';
  }

  // ===== 昼間人口・従業者密度 =====
  if (m.daytime_population) {
    var dp = m.daytime_population;
    html += '<div style="' + S + '"><div style="' + T + '">6. 昼間人口・従業者密度</div>';
    html += '<table style="' + TBL + '">';
    html += r('昼間人口', formatNumber(dp.daytime_pop));
    html += r('夜間人口', formatNumber(dp.nighttime_pop));
    html += r('昼夜間比率', dp.daytime_ratio || '—');
    html += r('流入通勤者数', formatNumber(dp.commuter_inflow));
    html += r('流出通勤者数', formatNumber(dp.commuter_outflow));
    html += r('従業者密度', dp.worker_density || '—');
    html += '</table></div>';
  }

  // ===== 消費力指数 =====
  if (m.spending_power) {
    var sp = m.spending_power;
    html += '<div style="' + S + '"><div style="' + T + '">7. 消費力指数</div>';
    html += '<table style="' + TBL + '">';
    html += r('平均世帯年収（万円）', sp.avg_household_income ? toMan(sp.avg_household_income) : '—');
    html += r('可処分所得（万円）', sp.disposable_income ? toMan(sp.disposable_income) : '—');
    html += r('月間消費支出（万円）', sp.monthly_expenditure ? toMan(sp.monthly_expenditure) : '—');
    html += r('エンゲル係数（%）', sp.engel_coefficient || '—');
    html += r('小売消費指数（全国=100）', sp.retail_spending_index || '—');
    html += r('飲食消費指数（全国=100）', sp.food_spending_index || '—');
    html += r('サービス消費指数（全国=100）', sp.service_spending_index || '—');
    html += r('外食率（%）', sp.eating_out_rate || '—');
    html += '</table></div>';
  }

  // ===== 消費支出内訳 =====
  if (m.consumer_spending) {
    var cs = m.consumer_spending;
    html += '<div style="' + S + '"><div style="' + T + '">8. 消費支出内訳（世帯月額）</div>';
    html += '<table style="' + TBL + '">';
    html += r('食料費', cs.food_total ? '¥' + formatNumber(cs.food_total) : '—');
    html += r('外食費', cs.eating_out ? '¥' + formatNumber(cs.eating_out) : '—');
    html += r('住居費', cs.housing ? '¥' + formatNumber(cs.housing) : '—');
    html += r('光熱・水道', cs.utilities ? '¥' + formatNumber(cs.utilities) : '—');
    html += r('交通費', cs.transportation ? '¥' + formatNumber(cs.transportation) : '—');
    html += r('通信費', cs.communication ? '¥' + formatNumber(cs.communication) : '—');
    html += r('教育費', cs.education ? '¥' + formatNumber(cs.education) : '—');
    html += r('教養娯楽費', cs.entertainment ? '¥' + formatNumber(cs.entertainment) : '—');
    html += r('医療費', cs.medical ? '¥' + formatNumber(cs.medical) : '—');
    html += r('被服費', cs.clothing ? '¥' + formatNumber(cs.clothing) : '—');
    html += r('理美容費', cs.personal_care ? '¥' + formatNumber(cs.personal_care) : '—');
    html += r('交際費', cs.social_expenses ? '¥' + formatNumber(cs.social_expenses) : '—');
    html += r('月間合計', cs.total_monthly ? '¥' + formatNumber(cs.total_monthly) : '—');
    html += '</table></div>';
  }

  // ===== 出店適性スコア =====
  if (m.location_score) {
    var ls = m.location_score;
    html += '<div style="' + S + '"><div style="' + T + '">9. 出店適性スコア</div>';
    html += '<table style="' + TBL + '">';
    html += r('総合スコア（/100）', ls.overall_score || '—');
    html += r('グレード', ls.grade || '—');
    html += r('交通・立地スコア', ls.traffic_score || '—');
    html += r('人口・世帯スコア', ls.population_score || '—');
    html += r('競合環境スコア', ls.competition_score || '—');
    html += r('消費力スコア', ls.spending_score || '—');
    html += r('成長性スコア', ls.growth_score || '—');
    if (ls.ai_recommendation) html += r('AI総合判定', ls.ai_recommendation);
    html += '</table></div>';
  }

  // ===== 集客チャネル =====
  if (m.marketing_channels) {
    var mc = m.marketing_channels;
    html += '<div style="' + S + '"><div style="' + T + '">10. 集客チャネル</div>';
    if (mc.channels && mc.channels.length > 0) {
      html += '<table style="' + TBL + '">';
      html += '<tr><th style="' + TH + 'width:26%;">チャネル</th><th style="' + TH + 'width:12%;">スコア</th><th style="' + TH + 'width:62%;">理由</th></tr>';
      mc.channels.forEach(function(ch) {
        html += '<tr><td style="' + TD + '">' + escapeHtml(ch.name || '') + '</td>';
        html += '<td style="' + TD + 'text-align:center; font-weight:700;">' + (ch.score || '') + '</td>';
        html += '<td style="' + TD + 'font-size:10px;">' + escapeHtml(ch.reason || '') + '</td></tr>';
      });
      html += '</table>';
    }
    if (mc.strategy_summary) {
      html += '<div style="margin-top:5px; padding:5px 8px; background:#f0fdf4; border:1px solid #86efac; border-radius:3px; font-size:10px; color:#166534;">' + escapeHtml(mc.strategy_summary) + '</div>';
    }
    html += '</div>';
  }

  // ===== フッター =====
  html += '<div style="text-align:center; margin-top:10px; padding-top:6px; border-top:1px solid #e2e8f0;">';
  html += '<div style="font-size:9px; color:#94a3b8;">AI出店商圏レポート v1.0 | Powered by AI + 政府統計データ | ' + dateStr + '</div>';
  html += '</div>';
  html += '</div>'; // ルートdiv閉じ

  // 新しいウィンドウで印刷（ブラウザネイティブレンダリングで高品質PDF）
  var printWin = window.open('', '_blank', 'width=800,height=1000');
  if (!printWin) { alert('ポップアップがブロックされました。ポップアップを許可してください。'); return; }

  printWin.document.write('<!DOCTYPE html><html><head><meta charset="utf-8">');
  printWin.document.write('<title>出店商圏分析_' + escapeHtml(area.fullLabel) + '</title>');
  printWin.document.write('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap" rel="stylesheet">');
  printWin.document.write('<style>');
  printWin.document.write('*{margin:0;padding:0;box-sizing:border-box;}');
  printWin.document.write('body{background:#fff;color:#000;font-family:"Noto Sans JP",sans-serif;font-size:12px;line-height:1.6;padding:20px 30px;}');
  printWin.document.write('@media print{body{padding:0;}@page{margin:12mm 15mm;}}');
  printWin.document.write('</style></head><body>');
  printWin.document.write(html);
  printWin.document.write('</body></html>');
  printWin.document.close();

  // フォント読み込み後に印刷ダイアログを表示
  printWin.onload = function() {
    setTimeout(function() { printWin.print(); }, 800);
  };
}

// ---- Excel Export ----
function handleExcelDownload() {
  if (!isPurchased) {
    alert('Excelダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportExcel();
}

function exportExcel() {
  if (!analysisData || !analysisData.shoken) { alert('分析データがありません'); return; }

  var m = analysisData.shoken;
  var area = analysisData.area;
  var wb = XLSX.utils.book_new();

  var merges = [];
  var rowHeights = [];
  var rows = [];

  function pushRow(cells) {
    rows.push(cells);
  }

  // ===== タイトル行 =====
  pushRow(['AI出店商圏レポート', '', '', '']);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });

  pushRow(['エリア', area.fullLabel, '', '']);
  pushRow(['分析日', new Date().toLocaleDateString('ja-JP'), '', '']);
  pushRow(['データソース', '政府統計(e-Stat) + AI分析(Gemini)', '', '']);

  function pushSectionHeader(title) {
    pushRow(['', '', '', '']); // 区切り空行
    var idx = rows.length;
    pushRow([title, '', '', '']);
    merges.push({ s: { r: idx, c: 0 }, e: { r: idx, c: 3 } });
  }

  function pushDataRow(label, val, unit) {
    var displayVal = (val === null || val === undefined || val === '') ? '—' : String(val);
    if (unit) displayVal = displayVal + unit;
    pushRow([label, displayVal, '', '']);
  }

  // ===== ① 人口・世帯データ =====
  pushSectionHeader('① 人口・世帯データ');
  var pop = m.population || {};
  pushDataRow('総人口', pop.total_population ? formatNumber(pop.total_population) : '', '');
  pushDataRow('世帯数', pop.households ? formatNumber(pop.households) : '', '');
  pushDataRow('人口密度', pop.population_density ? formatNumber(pop.population_density) : '', '人/km²');
  pushDataRow('人口増減率', pop.growth_rate, '');
  if (pop.source) pushDataRow('データソース', pop.source, '');

  // ===== ② 年齢構成 =====
  pushSectionHeader('② 年齢構成・ターゲット層');
  var ac = m.age_composition || {};
  pushDataRow('20歳未満', ac.under_20_pct, '%');
  pushDataRow('20〜34歳', ac.age_20_34_pct, '%');
  pushDataRow('35〜49歳', ac.age_35_49_pct, '%');
  pushDataRow('50〜64歳', ac.age_50_64_pct, '%');
  pushDataRow('65歳以上', ac.over_65_pct, '%');
  if (ac.primary_target) pushDataRow('メインターゲット', ac.primary_target, '');
  if (ac.secondary_target) pushDataRow('サブターゲット', ac.secondary_target, '');

  // ===== ③ 事業所統計 =====
  pushSectionHeader('③ 事業所・企業統計');
  var be = m.business_establishments || {};
  pushDataRow('総事業所数', be.total ? formatNumber(be.total) : '', '');
  pushDataRow('小売業', be.retail ? formatNumber(be.retail) : '', '');
  pushDataRow('飲食業', be.food_service ? formatNumber(be.food_service) : '', '');
  pushDataRow('サービス業', be.services ? formatNumber(be.services) : '', '');
  pushDataRow('医療・福祉', be.medical ? formatNumber(be.medical) : '', '');
  pushDataRow('人口1000人あたり事業所数', be.establishments_per_1000, '');
  if (be.source) pushDataRow('データソース', be.source, '');

  // ===== ④ 競合密度 =====
  pushSectionHeader('④ 業種別競合密度');
  var cd = m.competition_density || {};
  pushDataRow('小売密度（店/km²）', cd.retail_density, '');
  pushDataRow('飲食密度（店/km²）', cd.food_density, '');
  pushDataRow('サービス密度', cd.service_density, '');
  pushDataRow('飽和度指数', cd.saturation_index, '');
  pushDataRow('飽和レベル', cd.saturation_level, '');
  if (cd.top_chains && cd.top_chains.length > 0) {
    pushDataRow('主要競合チェーン', cd.top_chains.join(', '), '');
  }
  if (cd.opportunity_sectors && cd.opportunity_sectors.length > 0) {
    pushDataRow('参入余地のある業種', cd.opportunity_sectors.join(', '), '');
  }

  // ===== ⑤ 昼間人口 =====
  pushSectionHeader('⑤ 昼間人口・従業者密度');
  var dp = m.daytime_population || {};
  pushDataRow('昼間人口', dp.daytime_pop ? formatNumber(dp.daytime_pop) : '', '');
  pushDataRow('夜間人口', dp.nighttime_pop ? formatNumber(dp.nighttime_pop) : '', '');
  pushDataRow('昼夜間比率', dp.daytime_ratio, '');
  pushDataRow('流入通勤者数', dp.commuter_inflow ? formatNumber(dp.commuter_inflow) : '', '');
  pushDataRow('流出通勤者数', dp.commuter_outflow ? formatNumber(dp.commuter_outflow) : '', '');
  pushDataRow('従業者密度', dp.worker_density, '');

  // ===== ⑥ 消費力 =====
  pushSectionHeader('⑥ 消費力指数');
  var sp = m.spending_power || {};
  pushDataRow('平均世帯年収（万円）', sp.avg_household_income ? toMan(sp.avg_household_income) : '', '');
  pushDataRow('可処分所得（万円）', sp.disposable_income ? toMan(sp.disposable_income) : '', '');
  pushDataRow('月間消費支出（万円）', sp.monthly_expenditure ? toMan(sp.monthly_expenditure) : '', '');
  pushDataRow('エンゲル係数（%）', sp.engel_coefficient || '', '');
  pushDataRow('小売消費指数（全国=100）', sp.retail_spending_index, '');
  pushDataRow('飲食消費指数（全国=100）', sp.food_spending_index, '');
  pushDataRow('サービス消費指数（全国=100）', sp.service_spending_index || '', '');
  pushDataRow('外食率（%）', sp.eating_out_rate || '', '');

  // ===== ⑥-2 消費支出内訳 =====
  pushSectionHeader('⑥-2 消費支出内訳（世帯月額・円）');
  var cs = m.consumer_spending || {};
  pushDataRow('食料費', cs.food_total || '', '');
  pushDataRow('外食費', cs.eating_out || '', '');
  pushDataRow('住居費', cs.housing || '', '');
  pushDataRow('光熱・水道', cs.utilities || '', '');
  pushDataRow('交通費', cs.transportation || '', '');
  pushDataRow('通信費', cs.communication || '', '');
  pushDataRow('教育費', cs.education || '', '');
  pushDataRow('教養娯楽費', cs.entertainment || '', '');
  pushDataRow('医療費', cs.medical || '', '');
  pushDataRow('被服費', cs.clothing || '', '');
  pushDataRow('理美容費', cs.personal_care || '', '');
  pushDataRow('交際費', cs.social_expenses || '', '');
  pushDataRow('月間合計', cs.total_monthly || '', '');

  // ===== ⑧ 出店適性スコア =====
  pushSectionHeader('⑧ 出店適性スコア');
  var ls = m.location_score || {};
  pushDataRow('総合スコア（/100）', ls.overall_score, '');
  pushDataRow('グレード', ls.grade, '');
  pushDataRow('交通・立地スコア', ls.traffic_score, '');
  pushDataRow('人口・世帯スコア', ls.population_score, '');
  pushDataRow('競合環境スコア', ls.competition_score, '');
  pushDataRow('消費力スコア', ls.spending_score, '');
  pushDataRow('成長性スコア', ls.growth_score, '');
  if (ls.ai_recommendation) pushDataRow('AI総合判定', ls.ai_recommendation, '');

  // ===== ⑨ 集客チャネル =====
  pushSectionHeader('⑨ 集客チャネル');
  var mc = m.marketing_channels || {};
  var channels = mc.channels || [];
  if (channels.length > 0) {
    pushRow(['', '', '', '']); // 区切り空行
    var chHeaderIdx = rows.length;
    pushRow(['推奨集客チャネル', '', '', '']);
    merges.push({ s: { r: chHeaderIdx, c: 0 }, e: { r: chHeaderIdx, c: 3 } });
    pushRow(['チャネル名', 'スコア', 'プラットフォーム', '推奨理由']);
    channels.forEach(function(ch) {
      var plat = ch.platforms || '';
      pushRow([
        ch.name || '',
        ch.score || '',
        Array.isArray(plat) ? plat.join(', ') : String(plat),
        ch.reason || ''
      ]);
    });
  }
  pushDataRow('最も推奨チャネル', mc.best_channel, '');
  pushDataRow('集客戦略サマリー', mc.strategy_summary, '');

  // ===== ⑩ AI商圏分析サマリー =====
  pushSectionHeader('⑩ AI商圏分析サマリー');
  var summaryText = m.shoken_summary || '';
  var formattedSummary = summaryText.replace(/\r\n|\r|\n/g, '\r\n');
  var summaryRowIdx = rows.length;
  pushRow([formattedSummary, '', '', '']);
  merges.push({ s: { r: summaryRowIdx, c: 0 }, e: { r: summaryRowIdx, c: 3 } });
  rowHeights.push({ idx: summaryRowIdx, hpx: 200 });

  // ===== シート生成 =====
  var ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [{ wch: 28 }, { wch: 50 }, { wch: 30 }, { wch: 40 }];
  ws['!merges'] = merges;

  // 行高さの適用
  var wsRows = [];
  rowHeights.forEach(function(rh) { wsRows[rh.idx] = { hpx: rh.hpx }; });
  ws['!rows'] = wsRows;

  // xlsx-js-style: セルスタイルを適用
  var thinBorder = { style: 'thin', color: { rgb: 'CCCCCC' } };
  var borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  var wrapAlign = { wrapText: true, vertical: 'top' };

  // 全セルにwrapText + 罫線を適用
  var range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (var R = range.s.r; R <= range.e.r; R++) {
    for (var C = range.s.c; C <= range.e.c; C++) {
      var addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) ws[addr] = { v: '', t: 's' };
      ws[addr].s = { alignment: wrapAlign, border: borders, font: { name: 'Yu Gothic', sz: 10 } };
    }
  }

  // タイトル行(row 0)を太字・大きく
  var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
  if (ws[titleAddr]) {
    ws[titleAddr].s = { alignment: { horizontal: 'center', vertical: 'center' }, font: { name: 'Yu Gothic', sz: 14, bold: true }, border: borders };
  }

  // セクションヘッダー行を太字・背景色付き（エメラルドグリーン系）
  merges.forEach(function(mg) {
    var hdrAddr = XLSX.utils.encode_cell({ r: mg.s.r, c: 0 });
    if (ws[hdrAddr] && ws[hdrAddr].v && typeof ws[hdrAddr].v === 'string') {
      var val = ws[hdrAddr].v;
      if (val.match(/^[①-⑨]/) || val.match(/^\[/) || val.match(/^推奨/) || val === 'AI出店商圏レポート') {
        ws[hdrAddr].s = {
          alignment: wrapAlign,
          font: { name: 'Yu Gothic', sz: 11, bold: true, color: { rgb: '065F46' } },
          fill: { fgColor: { rgb: 'D1FAE5' } },
          border: borders
        };
      }
    }
  });

  // AI商圏分析サマリー行の特別スタイル
  var summaryAddr = XLSX.utils.encode_cell({ r: summaryRowIdx, c: 0 });
  if (ws[summaryAddr]) {
    ws[summaryAddr].s = { alignment: wrapAlign, font: { name: 'Yu Gothic', sz: 10 }, border: borders };
  }

  XLSX.utils.book_append_sheet(wb, ws, '商圏分析レポート');

  var fileName = '出店商圏分析_' + area.fullLabel + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

function cancelPurchasePrompt() {
  document.getElementById('purchase-prompt').style.display = 'none';
  // 閉じた後も再決済できるフローティングボタンを表示
  var floatBtn = document.getElementById('purchase-float-btn');
  if (!floatBtn) {
    floatBtn = document.createElement('button');
    floatBtn.id = 'purchase-float-btn';
    floatBtn.className = 'purchase-float-btn';
    floatBtn.textContent = '🔓 完全版を購入 ¥300';
    floatBtn.onclick = function() {
      floatBtn.style.display = 'none';
      document.getElementById('purchase-prompt').style.display = 'flex';
    };
    document.body.appendChild(floatBtn);
  }
  floatBtn.style.display = 'block';
}

function hidePurchaseFloat() {
  var floatBtn = document.getElementById('purchase-float-btn');
  if (floatBtn) floatBtn.style.display = 'none';
}

// ---- UI Helpers ----
function resetAll() {
  analysisData = null;
  currentArea = null;
  isPurchased = false;
  _analysisRunning = false;
  areaInput.value = '';
  hideResults();
  hideProgress();
  hideError();
  document.getElementById('purchase-prompt').style.display = 'none';
  hidePurchaseFloat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setLoading(isLoading) {
  analyzeBtn.classList.toggle('is-loading', isLoading);
  analyzeBtn.disabled = isLoading;
  // 分析中は入力フィールドもロック
  areaInput.disabled = isLoading;
  areaInput.style.opacity = isLoading ? '0.5' : '';
  areaInput.style.cursor = isLoading ? 'not-allowed' : '';
}

function showProgress() { progressSection.classList.add('is-active'); }
function hideProgress() { progressSection.classList.remove('is-active'); }

function activateStep(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('is-active');
}

function completeStep(id) {
  var el = document.getElementById(id);
  if (el) { el.classList.remove('is-active'); el.classList.add('is-done'); }
}

function showResults() { resultsSection.classList.add('is-active'); }
function hideResults() { resultsSection.classList.remove('is-active'); }

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('is-active');
}

function hideError() { errorMsg.classList.remove('is-active'); }

// 万円単位に変換（円単位で来た場合に対応）
function toMan(val) {
  if (!val || val === 0) return 0;
  // 100万以上なら円単位と判断して万に変換（例: 30000000→3000万）
  if (val > 100000) return Math.round(val / 10000);
  return val;
}

// 億円単位に変換（円単位で来た場合に対応）
function toOku(val) {
  if (!val || val === 0) return 0;
  // 1万以上なら円or万円単位と判断
  if (val > 1000000000) return Math.round(val / 100000000); // 円→億
  if (val > 10000) return Math.round(val / 10000); // 万円→億（稀）
  return val;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightMatch(text, query) {
  var escaped = escapeHtml(text);
  var escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + escapedQuery + ')', 'gi'), '<mark>$1</mark>');
}

function formatNumber(num) {
  if (num === null || num === undefined || num === '') return '—';
  var n = Number(num);
  if (isNaN(n)) return '—';
  return n.toLocaleString('ja-JP');
}

// ---- area-database.js の searchArea 関数（AREA_DATABASEを検索）----
function searchArea(input) {
  if (!input || typeof AREA_DATABASE === 'undefined') return [];
  var query = input.trim();
  var results = [];

  // 完全一致
  for (var i = 0; i < AREA_DATABASE.length; i++) {
    var a = AREA_DATABASE[i];
    if (a.fullLabel === query || a.name === query) {
      results.push(a);
    }
  }
  if (results.length > 0) return results;

  // 部分一致
  for (var i = 0; i < AREA_DATABASE.length; i++) {
    var a = AREA_DATABASE[i];
    if (a.fullLabel.indexOf(query) >= 0 || a.name.indexOf(query) >= 0) {
      results.push(a);
    }
  }

  return results;
}
