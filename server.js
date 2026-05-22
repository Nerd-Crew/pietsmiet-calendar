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
      // Möglichst echter Browser-Header, damit Cloudflare uns nicht blockt
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`pietsmiet.de antwortete mit HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const events = [];

  // Jeder Tag steckt in einem .day-Container (es gibt zwei Wochen-Slides)
  $('.pietsmiet-contentplan .day').each((_, dayEl) => {
    const dateText = $(dayEl).find('.videodate__date').first().text().trim(); // z.B. "18.05.2026"
    if (!dateText) return;

    const [day, month, year] = dateText.split('.');
    if (!day || !month || !year) return;
    const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD

    // --- Videos ---
    $(dayEl)
      .find('.contentplan-item--video')
      .each((_, itemEl) => {
        // .contentplan-time enthält die Uhrzeit + ein verschachteltes Icon-Div.
        // Wir nehmen nur den direkten Textknoten (die Uhrzeit), nicht das Icon.
        const timeText = $(itemEl)
          .find('.contentplan-time')
          .first()
          .contents()
          .filter((_, n) => n.type === 'text')
          .text()
          .trim();

        const time = (timeText.match(/\d{1,2}:\d{2}/) || [])[0];
        const title = $(itemEl).find('.contentplan-title').first().text().trim();
        const channel = $(itemEl).find('.contentplan-meta').first().text().trim();

        if (title && time) {
          events.push({
            type: 'video',
            date: dateStr,
            start: time,
            end: null, // Videos haben keine Endzeit -> Default später
            title,
            meta: channel || 'YouTube'
          });
        }
      });

    // --- Streams ---
    $(dayEl)
      .find('.contentplan-item--stream')
      .each((_, itemEl) => {
        // Zeit steht in .time-wrapper als "12:00 – 00:00" (Bindestrich kann – oder - sein)
        const wrapperText = $(itemEl).find('.time-wrapper').first().text();
        const times = wrapperText.match(/\d{1,2}:\d{2}/g) || [];

        const title = $(itemEl).find('.contentplan-title').first().text().trim();
        const game = $(itemEl).find('.contentplan-meta').first().text().trim();

        // Streams ohne erkennbare Uhrzeit (z.B. "Zeit TBA") trotzdem als
        // Ganztages-/Startpunkt eintragen, statt sie zu verlieren.
        if (title) {
          events.push({
            type: 'stream',
            date: dateStr,
            start: times[0] || null,
            end: times[1] || null,
            title,
            meta: game || 'Twitch'
          });
        }
      });
  });

  return events;
}

// "YYYY-MM-DD" + "HH:MM" -> Date (in lokaler Europe/Berlin-Annahme)
function toDate(dateStr, timeStr) {
  const [h, m] = timeStr.split(':');
  return new Date(`${dateStr}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00`);
}

// ICS-Kalender generieren
async function generateCalendar() {
  try {
    const events = await fetchContentplan();

    if (events.length === 0) {
      console.warn('⚠️  0 Events geparst – Struktur evtl. geändert. Alter Stand bleibt aktiv.');
      return cachedCalendar;
    }

    const calendar = ical({
      name: 'PietSmiet Contentplan',
      timezone: 'Europe/Berlin',
      prodId: { company: 'PietSmiet-Community', product: 'Contentplan' }
    });

    for (const event of events) {
      const emoji = event.type === 'stream' ? '🔴' : '🎬';
      const platform = event.type === 'stream' ? 'Twitch' : 'YouTube';
      const url =
        event.type === 'stream'
          ? 'https://twitch.tv/pietsmiet'
          : 'https://youtube.com/@PietSmiet';

      let startDate;
      let endDate;
      let allDay = false;

      if (event.start) {
        startDate = toDate(event.date, event.start);

        if (event.end) {
          endDate = toDate(event.date, event.end);
          // Ende <= Start bedeutet: über Mitternacht (z.B. 15:00 – 03:00) -> +1 Tag
          if (endDate <= startDate) {
            endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
          }
        } else {
          // Video oder Stream ohne Endzeit -> 1 Stunde Default
          endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
        }
      } else {
        // Kein Zeitwert (z.B. "Zeit TBA") -> Ganztagestermin
        startDate = toDate(event.date, '00:00');
        allDay = true;
      }

      // Eindeutige, stabile ID pro Event (für saubere Updates im Kalender)
      const slug = event.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40);

      calendar.createEvent({
        id: `pietsmiet-${event.type}-${event.date}-${event.start || 'allday'}-${slug}`,
        start: startDate,
        end: endDate,
        allDay,
        summary: `${emoji} ${event.title}`,
        description: `${platform}: ${event.meta}`,
        url
      });
    }

    console.log(`✅ Kalender aktualisiert: ${events.length} Events`);
    cachedCalendar = calendar;
    return calendar;
  } catch (error) {
    console.error('❌ Fehler:', error.message);
    return cachedCalendar; // alten Stand behalten statt leer auszuliefern
  }
}

// Kalender-Endpoint
app.get('/calendar.ics', async (req, res) => {
  const calendar = cachedCalendar || (await generateCalendar());

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
