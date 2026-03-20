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

if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
	if (!admin.apps.length) {
		admin.initializeApp({
			credential: admin.credential.cert({
				projectId: "suyash-28c0b",
				clientEmail: "firebase-adminsdk-fbsvc@suyash-28c0b.iam.gserviceaccount.com",
				privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDMbVcejFQctXhb\nxkXrgJPL56ksDQPoPw1TDEsQ+alsB+XyEOiuAU5EgJDm8EePOJI+Zmp6mCLlCHC2\n4NelWBplU7Tmq/KwY5ZkYvHdoRDgCpIeKa5RQuaAP7F63EVuBREwPYWpVKeN/6d3\nVwAQhu3exLcykyNRdQ8csDUc+Np3QKYVSiEJe7RPo7l8VDMfcZXu5NVSUO8NA1SV\nMkrXpjLCNJcVbaBKbPxaNTrZlRtUDsfIxN/8tZp8oZCFpq/6GLGQNtvzpHgjcF1n\nzIQrpgywQCaToNRsFyvl1jhDeKe0qE9GUDKcl0iScVz2+YK70TWMCPwa7uIrhX1Q\neenjAevVAgMBAAECggEATV34Qbx0POVFJt6UKbvgs6P6N4y5dNUgEtUtN8B1KUiX\n8xQJK4mc+Hn73RsEyiRr3KfgFoOreSjHl77iflYorz6N0Vs0HyOhkF6OEQXbIB+A\nC2BU87YxDEqOvePNdwT961btVheOzkP6OkU35glazxt+Ber/y91UmdPqVgusisLE\nnEppUiRY+3ZWlY0byDlAt7QySZCym1NU9ynVbdc/mx7XcYUVLGLFeIyTNHhiWZIJ\nnfhidou3+IAF1ohKEfILadvzGA5JeL1Kw4RgJkAj2auqYSstVPWIwFjl+hL3FIj4\n7F/6G0IbtQ+nt+jai+IKFBDavrJ3pC93dlCJAZNwBQKBgQDrravCQh0DOoI+J8TJ\ni52INkNznXohfFc0GDJa5QVP+YrTCyObrFZ6vUxu9wy9QDrL1WwGs7Rkn3uhCjZf\nM48Yj9oL0s+Qe7H4WdsYese4BjcyahS36JpkqMIA/VOGGMwsw9yl9CnjJaMER5Tp\nNZ/jdf0QA6M6fgjNPHTGxX1iXwKBgQDeDdVIokH/RMKrZdynYM9D3gvOFTWiNHj4\nrH2CxabDsTK5WpgPkEnzBToB2CdWqCmJKBlwuxWkLQ5WYVBqmNqluoZQyJnZ4uXR\nKX0/SDUKCFiSbmpyxyUnNSKZur7oP35m7RUC6tUi4bOjGJpMAN2v8n2CrG0fosMX\n3yzEjNQmSwKBgQDiXGJWKG35Rd8Gl+fYtLJPu965Uw2Uz/pp3LuwtbuOft2pqk8/\nHB3LsbmR8tNXijNux8QEA+JFqzBxEn/6nGjabIA/TvFxknzzTkqzjmn5BG9Lirvv\nkAeKmtQLY0UvzO1+KXjqJEN/Gg0i9SW/gHPbYt323aePbLJDfcejitfM/QKBgQCj\noz4SEMDiBSIQfThmgIk9Ul0QucCUkGa1myfDPzTt8Z+XyJNWpNZaKPfedBRJYBN7\n5/kXgkcofaubLIu+gnZeu15QGgSG9Ra3VQPfpq6vfgcHoib//pH6msWs1FnrfR8B\naqWZSMVYt0tSXccXS2wTRXgI3Fhuf9uVs/mhvsZ4kQKBgQCy3ibwpA3z0z9JETz+\njdF+C5qaW7ejMm5i27k/aw+BUXx75EqzwCSFod7eoQxACSXQ37RKqQeEL5GspAnO\nvHi8lvkvjN/Zb+VaMeOy1nBwghrX+enygjMPHOB39M4gNltn4NIIE6HavVfruD88\n5OHbLet1zLEL58hY9A/DbzRvDg==\n-----END PRIVATE KEY-----\n",
			}),
			projectId: "suyash-28c0b", 
		});
	}
} else {
	console.warn('Firebase credentials are missing. Check your .env file.');
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
app.use(express.urlencoded({ extended: true }));
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
