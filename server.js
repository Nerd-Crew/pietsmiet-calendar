import express from 'express';
import ical from 'ical-generator';
import * as cheerio from 'cheerio';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;

let cachedCalendar = null;

// Contentplan von pietsmiet.de scrapen
async function fetchContentplan() {
  const response = await fetch('https://www.pietsmiet.de/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const events = [];
  
  // Durch alle Tage im Contentplan iterieren
  $('.day').each((_, dayEl) => {
    const dateText = $(dayEl).find('.videodate__date').text().trim(); // z.B. "02.02.2026"
    
    if (!dateText) return;
    
    // Datum parsen (DD.MM.YYYY -> YYYY-MM-DD)
    const [day, month, year] = dateText.split('.');
    const dateStr = `${year}-${month}-${day}`;
    
    // Videos
    $(dayEl).find('.contentplan-item--video').each((_, itemEl) => {
      const time = $(itemEl).find('.contentplan-time').text().trim().split('\n')[0].trim();
      const title = $(itemEl).find('.contentplan-title').text().trim();
      const channel = $(itemEl).find('.contentplan-meta').text().trim();
      
      if (title && time) {
        events.push({
          type: 'video',
          date: dateStr,
          time: time,
          title: title,
          channel: channel || 'YouTube'
        });
      }
    });
    
    // Streams
    $(dayEl).find('.contentplan-item--stream').each((_, itemEl) => {
      const time = $(itemEl).find('.time-wrapper').text().trim();
      const title = $(itemEl).find('.contentplan-title').text().trim();
      const game = $(itemEl).find('.contentplan-meta').text().trim();
      
      if (title && time) {
        events.push({
          type: 'stream',
          date: dateStr,
          time: time,
          title: title,
          game: game || 'Twitch'
        });
      }
    });
  });
  
  return events;
}

// ICS-Kalender generieren
async function generateCalendar() {
  try {
    const events = await fetchContentplan();
    
    const calendar = ical({
      name: 'PietSmiet Contentplan',
      timezone: 'Europe/Berlin',
      prodId: { company: 'PietSmiet-Community', product: 'Contentplan' }
    });

    for (const event of events) {
      const [hours, minutes] = event.time.split(':');
      const startDate = new Date(`${event.date}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1 Stunde

      const emoji = event.type === 'stream' ? '🔴' : '🎬';
      const platform = event.type === 'stream' ? 'Twitch' : 'YouTube';

      calendar.createEvent({
        id: `pietsmiet-${event.type}-${event.date}-${event.time.replace(':', '')}`,
        start: startDate,
        end: endDate,
        summary: `${emoji} ${event.title}`,
        description: `${platform}: ${event.channel || event.game || 'PietSmiet'}`,
        url: event.type === 'stream' 
          ? 'https://twitch.tv/pietsmiet' 
          : 'https://youtube.com/pietsmiet'
      });
    }

    console.log(`✅ Kalender aktualisiert: ${events.length} Events`);
    cachedCalendar = calendar;
    return calendar;

  } catch (error) {
    console.error('❌ Fehler:', error.message);
    return cachedCalendar;
  }
}

// Kalender-Endpoint
app.get('/calendar.ics', async (req, res) => {
  let calendar = cachedCalendar || await generateCalendar();

  if (calendar) {
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pietsmiet.ics"'
    });
    res.send(calendar.toString());
  } else {
    res.status(500).send('Kalender konnte nicht generiert werden');
  }
});

// Info-Seite
app.get('/', (req, res) => {
  res.send(`
    <h1>🎮 PietSmiet Kalender-Feed</h1>
    <p>Abonniere diesen Kalender:</p>
    <code>${req.protocol}://${req.get('host')}/calendar.ics</code>
    <br><br>
    <a href="/calendar.ics">📅 Kalender herunterladen</a>
  `);
});

// Alle 30 Minuten aktualisieren
cron.schedule('*/30 * * * *', () => generateCalendar());

app.listen(PORT, async () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);
  await generateCalendar();
});