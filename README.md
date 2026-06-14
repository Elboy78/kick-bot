# 🎮 Kick Loyalty Bot

Bot de fidélité pour chaîne Kick.com — attribue des points aux viewers qui regardent le stream.

---

## Fonctionnalités

- **Points automatiques** → +10 pts toutes les 5 minutes aux viewers actifs dans le chat
- **Commandes chat** → `!points`, `!top`, `!rang`, `!aide`
- **Panel web** → classement, stats, recherche, gestion admin
- **Base de données** → SQLite locale, aucun serveur externe requis

---

## Installation (5 minutes)

### 1. Prérequis

- [Node.js](https://nodejs.org) version 18 ou supérieure

### 2. Télécharger et installer

```bash
# Aller dans le dossier du bot
cd kick-bot

# Installer les dépendances
npm install
```

### 3. Configurer

```bash
# Copier le fichier d'exemple
cp .env.example .env
```

Ouvrez `.env` et remplissez les valeurs :

```env
KICK_CHANNEL=votre_chaine          # Votre pseudo Kick (sans @)
KICK_CHANNEL_ID=123456             # L'ID numérique de votre chaîne
KICK_TOKEN=votre_token             # Votre token d'authentification
BOT_USERNAME=votre_bot             # Le pseudo du compte bot
PANEL_SECRET=ma_cle_secrete        # Mot de passe pour l'admin du panel
```

#### Trouver votre KICK_CHANNEL_ID

Rendez-vous sur `https://kick.com/api/v2/channels/VOTRE_PSEUDO`
Le champ `id` est votre `KICK_CHANNEL_ID`.

#### Trouver votre KICK_TOKEN

1. Connectez-vous à [kick.com](https://kick.com) avec le compte bot
2. Appuyez sur **F12** → onglet **Application** (ou **Storage**)
3. → **Cookies** → `https://kick.com`
4. Copiez la valeur du cookie `kick_session`

---

## Démarrage

### Démarrer le bot seul

```bash
node bot.js
```

### Démarrer le panel web seul

```bash
node panel.js
```

### Démarrer les deux ensemble

```bash
# Dans deux terminaux séparés :
node bot.js
node panel.js

# Ou avec npm-run-all (optionnel) :
npm run dev
```

---

## Panel web

Accédez à **http://localhost:3000** dans votre navigateur.

Le panel affiche :
- 📊 **Stats globales** — nombre de viewers, points distribués, temps total regardé
- 🏆 **Classement** — top viewers avec barre de progression
- 🔍 **Recherche** — trouver un viewer et voir ses stats détaillées
- ⚙️ **Admin** — ajouter/retirer/réinitialiser des points (nécessite la clé secrète)
- 📋 **Logs** — historique des derniers gains de points

---

## Commandes chat

| Commande | Description |
|----------|-------------|
| `!points` | Affiche vos points et votre rang |
| `!top` | Affiche le top 5 des viewers |
| `!rang` | Affiche votre position dans le classement |
| `!aide` | Liste toutes les commandes |

---

## Configuration avancée

Modifiez `.env` pour ajuster les points :

```env
# +15 points toutes les 10 minutes
POINTS_PER_INTERVAL=15
POINTS_INTERVAL_MS=600000
```

---

## Structure du projet

```
kick-bot/
├── bot.js          → Bot WebSocket Kick (commandes + points)
├── panel.js        → Serveur web du dashboard
├── database.js     → Gestion SQLite (viewers, points, logs)
├── .env.example    → Modèle de configuration
├── .env            → Votre configuration (à créer)
├── package.json    → Dépendances Node.js
├── data/
│   └── viewers.db  → Base de données (créée automatiquement)
└── public/
    └── index.html  → Interface du panel web
```

---

## Dépannage

**Le bot ne reçoit pas les messages du chat**
→ Vérifiez que `KICK_CHANNEL_ID` est correct et que votre token est valide.

**Le bot ne peut pas envoyer de messages**
→ Vérifiez que `KICK_TOKEN` est le token du compte connecté à kick.com.

**Le panel affiche "Erreur de chargement"**
→ Assurez-vous que `node panel.js` est lancé et accessible sur le port 3000.

**Les points ne s'accumulent pas**
→ Les points sont distribués aux viewers qui ont **écrit au moins un message** dans l'intervalle. Si personne ne parle, aucun point n'est distribué.
