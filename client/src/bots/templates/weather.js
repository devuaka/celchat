// Weather bot: /weather <city> using Open-Meteo (free, no API key).
// Needs "Can use the internet" turned on. Requests go out from the device running the bot.

const CODES = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'], 51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'],
  75: ['❄️', 'Heavy snow'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'], 95: ['⛈️', 'Thunderstorm'],
};

bot.command('weather', 'Current weather for a city', ['city:text'], async (ctx, { city }) => {
  if (!bot.canUseInternet) return ctx.reply('My owner has not allowed me to use the internet yet.');
  const geo = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city))).json();
  const place = geo.results && geo.results[0];
  if (!place) return ctx.reply(`I could not find "${city}".`);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
  const w = await (await fetch(url)).json();
  const c = w.current;
  const [icon, label] = CODES[c.weather_code] || ['🌡️', 'Weather'];
  await ctx.reply({
    embeds: [{
      title: `${icon} ${place.name}${place.country ? ', ' + place.country : ''}`,
      description: label,
      color: '#4aa8ff',
      fields: [
        { name: 'Temperature', value: `${c.temperature_2m} °C (feels ${c.apparent_temperature} °C)`, inline: true },
        { name: 'Today', value: `${w.daily.temperature_2m_min[0]} to ${w.daily.temperature_2m_max[0]} °C`, inline: true },
        { name: 'Humidity', value: `${c.relative_humidity_2m}%`, inline: true },
        { name: 'Wind', value: `${c.wind_speed_10m} km/h`, inline: true },
      ],
      footer: 'Weather data by Open-Meteo.com',
    }],
  });
});
