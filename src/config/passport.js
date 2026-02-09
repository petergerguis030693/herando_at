const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');

module.exports = (passport, db) => {
  // Serialisieren / Deserialisieren
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const [[user]] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });

  // Local-Login
  passport.use('local-login', new LocalStrategy({
      usernameField: 'email',
      passwordField: 'password'
    },
    async (email, password, done) => {
      try {
        const [[user]] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) return done(null, false, { message: 'Unknown email' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return done(null, false, { message: 'Wrong password' });
        return done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
};
