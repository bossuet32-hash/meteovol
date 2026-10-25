# Météo vol

Compagnon de terrain du télépilote, en web app installable sur iPhone (PWA) :

- **Météo** : METAR/TAF décodés des aérodromes proches, verdict vent / rafales / visibilité / plafond, vent de travers, créneaux favorables, soleil, indice Kp (GNSS).
- **Bulletin** : prévisions Météo-France (AROME/ARPEGE via Open-Meteo) heure par heure et sur 4 jours, radar de précipitations animé.
- **Zones** : zones géographiques UAS du SIA (ED-269) et ZICAD hors ligne, carte IGN avec limites communales, analyse au point de vol, espaces protégés (INPN), points de vigilance (OpenStreetMap).
- **Missions** : dossiers mission (lieu, date, checklist, documents), archive PDF METAR/TAF + bulletin + zones, documents permanents (licence, MANEX…).

Ouvrir : https://bossuet32-hash.github.io/meteovol/ puis, dans Safari, **Partager → Sur l'écran d'accueil**.

## Mise à jour des zones (chaque cycle AIRAC, 28 jours)

1. Télécharger le ZIP « Données zones géographiques UAS » sur le site du SIA (gratuit).
2. Sur GitHub, ouvrir le dossier `sources/`, **Add file → Upload files**, déposer le ZIP (`UASZones_AAAA-MM-JJ_….zip`) et valider.
3. L'action « Zones SIA / ZICAD » reconstruit `data/zones/` en 1 à 2 minutes ; l'app se met à jour à la prochaine ouverture.

Le KML ZICAD (data.gouv.fr) se met à jour de la même façon (`sources/ZICAD_*.zip`).

## Sources

met.no (METAR/TAF), aviationweather.gov / NOAA (METAR/TAF de secours, Kp), Open-Meteo / Météo-France, RainViewer, SIA (zones UAS), SGDSN / IGN (ZICAD, Licence Ouverte), IGN Géoplateforme (cartes, géocodage, limites), PatriNat / INPN (espaces protégés), OpenStreetMap (ODbL), OurAirports (aérodromes, domaine public).

Outil d'aide à la préparation : ne remplace ni l'AIP, ni les SUP AIP, ni les NOTAM.
