const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

// Лимит запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 1000 // максимум 1000 запросов
});
app.use('/api/', limiter);

// Папки для данных
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const USERS_DIR = path.join(DATA_DIR, 'users');
const STATS_DIR = path.join(DATA_DIR, 'stats');

// Создаем директории если их нет
[LOGS_DIR, USERS_DIR, STATS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Хранилище в памяти для быстрого доступа
const analyticsStore = {
  requests: new Map(), // extensionId -> requests[]
  errors: new Map(),   // extensionId -> errors[]
  events: new Map(),   // extensionId -> events[]
  users: new Map()     // extensionId -> userInfo
};

// API: Получение логов
app.post('/api/logs', (req, res) => {
  try {
    const { extensionId, message, type, timestamp, proxy } = req.body;
    
    if (!extensionId) {
      return res.status(400).json({ error: 'extensionId required' });
    }
    
    // Сохраняем в файл
    const userDir = path.join(LOGS_DIR, extensionId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    
    const logFile = path.join(userDir, `${new Date().toISOString().split('T')[0]}.json`);
    const logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
    
    logs.push({
      timestamp: timestamp || Date.now(),
      type: type || 'info',
      message,
      proxy,
      ip: req.ip
    });
    
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    
    // Сохраняем в памяти
    if (!analyticsStore.events.has(extensionId)) {
      analyticsStore.events.set(extensionId, []);
    }
    analyticsStore.events.get(extensionId).push(req.body);
    
    res.json({ success: true, received: true });
  } catch (error) {
    console.error('Error saving log:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Получение статистики
app.post('/api/stats', (req, res) => {
  try {
    const { extensionId, type, url, domain, proxy, domains, proxyConfig } = req.body;
    
    if (!extensionId) {
      return res.status(400).json({ error: 'extensionId required' });
    }
    
    // Сохраняем статистику по пользователю
    const userStatsDir = path.join(STATS_DIR, extensionId);
    if (!fs.existsSync(userStatsDir)) fs.mkdirSync(userStatsDir, { recursive: true });
    
    const statFile = path.join(userStatsDir, 'stats.json');
    const stats = fs.existsSync(statFile) ? JSON.parse(fs.readFileSync(statFile, 'utf8')) : {
      totalRequests: 0,
      domains: [],
      proxyUsage: [],
      traffic: { total: 0, daily: {} }
    };
    
    // Обновляем статистику
    stats.totalRequests++;
    
    if (domain && !stats.domains.includes(domain)) {
      stats.domains.push(domain);
    }
    
    if (proxy) {
      stats.proxyUsage.push({
        proxy,
        timestamp: Date.now(),
        domain,
        type
      });
    }
    
    // Сохраняем конфигурацию пользователя
    if (proxyConfig) {
      const userFile = path.join(USERS_DIR, `${extensionId}.json`);
      const userData = fs.existsSync(userFile) ? 
        JSON.parse(fs.readFileSync(userFile, 'utf8')) : {};
      
      userData.lastActive = Date.now();
      userData.proxyConfig = proxyConfig;
      userData.domains = domains || [];
      userData.ip = req.ip;
      userData.userAgent = req.get('User-Agent');
      
      fs.writeFileSync(userFile, JSON.stringify(userData, null, 2));
      analyticsStore.users.set(extensionId, userData);
    }
    
    fs.writeFileSync(statFile, JSON.stringify(stats, null, 2));
    
    // Сохраняем в памяти
    if (!analyticsStore.requests.has(extensionId)) {
      analyticsStore.requests.set(extensionId, []);
    }
    analyticsStore.requests.get(extensionId).push(req.body);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Детальная аналитика
app.post('/api/analytics', (req, res) => {
  try {
    const { type, data, extensionId, sessionId } = req.body;
    
    if (!extensionId) {
      return res.status(400).json({ error: 'extensionId required' });
    }
    
    // Сохраняем детальную аналитику
    const analyticsDir = path.join(LOGS_DIR, extensionId, 'analytics');
    if (!fs.existsSync(analyticsDir)) fs.mkdirSync(analyticsDir, { recursive: true });
    
    const analyticsFile = path.join(analyticsDir, `${type}_${Date.now()}.json`);
    fs.writeFileSync(analyticsFile, JSON.stringify({
      sessionId,
      timestamp: Date.now(),
      type,
      data,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    }, null, 2));
    
    // Обрабатываем разные типы аналитики
    switch (type) {
      case 'request':
        if (!analyticsStore.requests.has(extensionId)) {
          analyticsStore.requests.set(extensionId, []);
        }
        analyticsStore.requests.get(extensionId).push(data);
        break;
        
      case 'error':
        if (!analyticsStore.errors.has(extensionId)) {
          analyticsStore.errors.set(extensionId, []);
        }
        analyticsStore.errors.get(extensionId).push(data);
        break;
        
      case 'batch':
        // Пакетная обработка
        if (data.requests) {
          if (!analyticsStore.requests.has(extensionId)) {
            analyticsStore.requests.set(extensionId, []);
          }
          analyticsStore.requests.get(extensionId).push(...data.requests);
        }
        if (data.errors) {
          if (!analyticsStore.errors.has(extensionId)) {
            analyticsStore.errors.set(extensionId, []);
          }
          analyticsStore.errors.get(extensionId).push(...data.errors);
        }
        break;
    }
    
    res.json({ success: true, received: true });
  } catch (error) {
    console.error('Error saving analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Получение данных для dashboard
app.get('/api/dashboard', (req, res) => {
  try {
    const totalUsers = fs.readdirSync(USERS_DIR).length;
    const totalRequests = Array.from(analyticsStore.requests.values())
      .reduce((acc, arr) => acc + arr.length, 0);
    
    // Активные пользователи (последние 24 часа)
    const activeUsers = Array.from(analyticsStore.users.values())
      .filter(user => Date.now() - user.lastActive < 24 * 60 * 60 * 1000)
      .length;
    
    // Популярные прокси
    const proxyUsage = {};
    analyticsStore.users.forEach(user => {
      if (user.proxyConfig?.host) {
        const proxy = user.proxyConfig.host;
        proxyUsage[proxy] = (proxyUsage[proxy] || 0) + 1;
      }
    });
    
    // Статистика по доменам
    const domainStats = {};
    analyticsStore.requests.forEach(requests => {
      requests.forEach(req => {
        if (req.domain) {
          domainStats[req.domain] = (domainStats[req.domain] || 0) + 1;
        }
      });
    });
    
    res.json({
      summary: {
        totalUsers,
        activeUsers,
        totalRequests,
        totalErrors: Array.from(analyticsStore.errors.values())
          .reduce((acc, arr) => acc + arr.length, 0),
        uptime: process.uptime()
      },
      proxyUsage: Object.entries(proxyUsage)
        .map(([proxy, count]) => ({ proxy, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topDomains: Object.entries(domainStats)
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      recentEvents: Array.from(analyticsStore.events.values())
        .flat()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50)
    });
  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Получение данных конкретного пользователя
app.get('/api/user/:extensionId', (req, res) => {
  try {
    const { extensionId } = req.params;
    
    const userFile = path.join(USERS_DIR, `${extensionId}.json`);
    if (!fs.existsSync(userFile)) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    
    // Получаем логи пользователя
    const logsDir = path.join(LOGS_DIR, extensionId);
    const logs = [];
    
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir)
        .filter(file => file.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 10);
      
      logFiles.forEach(file => {
        const filePath = path.join(logsDir, file);
        const fileLogs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        logs.push(...fileLogs);
      });
    }
    
    res.json({
      user: userData,
      logs: logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100),
      requests: analyticsStore.requests.get(extensionId) || [],
      errors: analyticsStore.errors.get(extensionId) || []
    });
  } catch (error) {
    console.error('Error getting user data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Статичные файлы
app.use(express.static('public'));

// Экспорт данных (для администратора)
app.get('/api/export', (req, res) => {
  try {
    // Проверка авторизации (упрощенно)
    const authToken = req.headers['authorization'];
    if (authToken !== 'Bearer admin123') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const exportData = {
      timestamp: new Date().toISOString(),
      totalUsers: analyticsStore.users.size,
      analyticsStore: Object.fromEntries(analyticsStore.requests),
      users: Object.fromEntries(analyticsStore.users)
    };
    
    const exportFile = path.join(DATA_DIR, `export_${Date.now()}.json`);
    fs.writeFileSync(exportFile, JSON.stringify(exportData, null, 2));
    
    res.download(exportFile);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер логирования запущен на порту ${PORT}`);
  console.log(`📊 Dashboard доступен по адресу: http://localhost:${PORT}/dashboard`);
});
