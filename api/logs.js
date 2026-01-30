// /api/logs.js - простой API для Vercel
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const logData = req.body;
    
    // Просто логируем в консоль Vercel
    console.log('📝 Proxy Master Log:', {
      timestamp: new Date().toISOString(),
      ...logData
    });
    
    // Отвечаем успехом
    return res.status(200).json({ 
      success: true,
      received: true,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Vercel API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
