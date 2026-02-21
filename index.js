const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

dotenv.config();

const {
	FIREBASE_PROJECT_ID,
	FIREBASE_CLIENT_EMAIL,
	FIREBASE_PRIVATE_KEY,
	PORT = 4000,
} = process.env;

if (!admin.apps.length) {
	if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
		admin.initializeApp({
			credential: admin.credential.cert({
				projectId: FIREBASE_PROJECT_ID,
				clientEmail: FIREBASE_CLIENT_EMAIL,
				privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
			}),
		});
	} else {
		// On GCE/GKE/Cloud Run, this uses the attached service account (Application Default Credentials).
		admin.initializeApp();
		console.warn('Firebase explicit credentials not set; using Application Default Credentials.');
	}
}

const userBetsRoutes = require('./routes/userBets');
const addMoneyByGetwayRoutes = require('./routes/addMoneyByGetway');
const userWithdrawalRoutes = require('./routes/userWithdrawal');
const manualDepositeRoutes = require('./routes/manualDeposite');
const gameChartRoutes = require('./routes/gameChart');
const userResetPasswordRoutes = require('./routes/userResetPassword');
const clearGameResultRoutes = require('./routes/clearGameResult');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/user-bets', userBetsRoutes);
app.use('/api/add-money', addMoneyByGetwayRoutes);
app.use('/api/user-withdrawal', userWithdrawalRoutes);
app.use('/api/manual-deposite', manualDepositeRoutes);
app.use('/api/game-chart', gameChartRoutes);
app.use('/api', userResetPasswordRoutes);
app.use('/api', clearGameResultRoutes);

app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

app.listen(PORT,"0.0.0.0", () => {
	console.log(`Server running on port ${PORT}`);
});
