/* Server list.
   type "cloudflare" -> /__down, /__up, /meta
   type "librespeed"  -> LibreSpeed backend (garbage.php / empty.php / getIP.php, cors=true)
   Sources: speed.cloudflare.com + librespeed.org/backend-servers/servers.php (LGPLv3 project) */
(function (g) {
  var LS = function (name, server, dir) {
    dir = dir === undefined ? 'backend/' : dir;
    return {
      name: name, type: 'librespeed', server: server,
      dlURL: dir + 'garbage.php', ulURL: dir + 'empty.php',
      pingURL: dir + 'empty.php', getIpURL: dir + 'getIP.php'
    };
  };

  g.SERVERS = [
    { name: 'Cloudflare (Anycast, global)', type: 'cloudflare', server: 'https://speed.cloudflare.com' },

    LS('Amsterdam, Netherlands (Clouvider)', 'https://ams.speedtest.clouvider.net/backend', ''),
    LS('Amsterdam, Netherlands (Sharktech)', 'https://amsspeed.sharktech.net'),
    LS('Argalasti, Greece (Cosmote)', 'https://argalasti.skoultsos.eu'),
    LS('Atlanta, USA (Clouvider)', 'https://atl.speedtest.clouvider.net/backend', ''),
    LS('Bangalore, India (DigitalOcean)', 'https://in1.backend.librespeed.org', ''),
    LS('Bari, Italy (GARR)', 'https://st-be-ba1.infra.garr.it', ''),
    LS('Bologna, Italy (GARR)', 'https://st-be-bo1.infra.garr.it', ''),
    LS('Bucharest, Romania (ByteShield)', 'https://speedtest.byteshield.ro:6060'),
    LS('Chicago, USA (Sharktech)', 'https://chispeed.sharktech.net'),
    LS('Denver, USA (Sharktech)', 'https://denspeed.sharktech.net'),
    LS('Frankfurt, Germany (Clouvider)', 'https://fra.speedtest.clouvider.net/backend', ''),
    LS('Frankfurt, Germany (LumischVPS)', 'https://speedtest.lumischvps.cloud'),
    LS('Ghom, Iran (Amin IDC)', 'https://fastme.ir'),
    LS('Grand Rapids, USA (RackGenius)', 'https://mispeed.rackgenius.com'),
    LS('Helsinki, Finland (openspeed)', 'https://finew.openspeed.org', 'backend437/'),
    LS('Helsinki, Finland (KABI)', 'https://fast.kabi.tk', ''),
    LS('Helsinki, Finland (librespeed.fi)', 'https://www.librespeed.fi'),
    LS('Johannesburg, South Africa (HostAfrica)', 'https://za1.backend.librespeed.org', ''),
    LS('Las Vegas, USA (Sharktech)', 'https://lasspeed.sharktech.net'),
    LS('London, UK (Clouvider)', 'https://lon.speedtest.clouvider.net/backend', ''),
    LS('Los Angeles, USA (Clouvider)', 'https://la.speedtest.clouvider.net/backend', ''),
    LS('Los Angeles, USA (Sharktech)', 'https://laxspeed.sharktech.net'),
    LS('New York, USA (Clouvider)', 'https://nyc.speedtest.clouvider.net/backend', ''),
    LS('Nottingham, UK (LayerIP)', 'https://uk1.backend.librespeed.org', ''),
    LS('Novi Sad, Serbia (E-CAPS)', 'https://speed1.e-caps.net'),
    LS('Nuremberg, Germany (1)', 'https://de1.backend.librespeed.org', ''),
    LS('Nuremberg, Germany (2)', 'https://de4.backend.librespeed.org', ''),
    LS('Nuremberg, Germany (3)', 'https://de3.backend.librespeed.org', ''),
    LS('Nuremberg, Germany (4)', 'https://de5.backend.librespeed.org', ''),
    LS('Nuremberg, Germany (5)', 'https://librespeed.lukas-heinrich.com', ''),
    {
      name: 'Ohio, USA (Rust backend)', type: 'librespeed', server: 'https://librespeed-rs.ir',
      dlURL: 'backend/garbage', ulURL: 'backend/empty', pingURL: 'backend/empty', getIpURL: 'backend/getIP'
    },
    LS('Poznan, Poland (INEA)', 'https://speedtest.kamilszczepanski.com', ''),
    LS('Prague, Czechia (CESNET)', 'https://speedtest.cesnet.cz'),
    LS('Prague, Czechia (Turris)', 'https://librespeed.turris.cz'),
    LS('Rome, Italy (GARR)', 'https://st-be-rm2.infra.garr.it', ''),
    LS('Serbia (SOX)', 'https://speedtest2.sox.rs', 'libre/backend/'),
    LS('Singapore (DS Group)', 'https://speedtest.dsgroupmedia.com'),
    LS('Tehran, Iran (Fanava)', 'https://speedme.ir'),
    LS('Tehran, Iran (Faraso)', 'https://st.bardia.tech'),
    LS('Tokyo, Japan (A573)', 'https://librespeed.a573.net'),
    LS('Vilnius, Lithuania (Time4VPS)', 'https://lt1.backend.librespeed.org', ''),
    LS('Virginia, USA (OVH)', 'https://speed.riverside.rocks', ''),
    LS('Volzhsky, Russia (PowerNet)', 'https://speedtest.powernet.com.ru')
  ];

  /* Candidates probed when "Auto" is selected (fast, geographically spread). */
  g.AUTO_CANDIDATES = [
    'Cloudflare (Anycast, global)',
    'Bangalore, India (DigitalOcean)',
    'Singapore (DS Group)',
    'Tokyo, Japan (A573)',
    'Frankfurt, Germany (Clouvider)',
    'London, UK (Clouvider)',
    'Nuremberg, Germany (2)',
    'New York, USA (Clouvider)',
    'Los Angeles, USA (Clouvider)',
    'Johannesburg, South Africa (HostAfrica)'
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = g.SERVERS;
})(typeof self !== 'undefined' ? self : globalThis);
