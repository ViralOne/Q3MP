/*
===========================================================================
Copyright (C) 1999-2005 Id Software, Inc.

This file is part of Quake III Arena source code.

Quake III Arena source code is free software; you can redistribute it
and/or modify it under the terms of the GNU General Public License as
published by the Free Software Foundation; either version 2 of the License,
or (at your option) any later version.

Quake III Arena source code is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Quake III Arena source code; if not, write to the Free Software
Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
===========================================================================
*/
//
// g_combat.c

#include "g_local.h"

static void G_NotifyKillPost( gentity_t *attacker, gentity_t *victim, int meansOfDeath ) {
	if ( !attacker || !attacker->client || !victim || !victim->client ) {
		return;
	}
	if ( attacker->r.svFlags & SVF_BOT ) {
		return;
	}

	/*
	 * qagame usually runs as QVM in this project; dispatch through a server
	 * console command so the engine can perform the HTTP request.
	 */
	trap_SendConsoleCommand(
		EXEC_APPEND,
		va(
			"q3js_killpost %d %d %d %d\n",
			attacker->s.number,
			victim->s.number,
			meansOfDeath,
			level.time
		)
	);
}

/*
============
ScorePlum
============
*/
void ScorePlum( gentity_t *ent, vec3_t origin, int score ) {
	gentity_t *plum;

	plum = G_TempEntity( origin, EV_SCOREPLUM );
	// only send this temp entity to a single client
	plum->r.svFlags |= SVF_SINGLECLIENT;
	plum->r.singleClient = ent->s.number;
	//
	plum->s.otherEntityNum = ent->s.number;
	plum->s.time = score;
}

/*
============
AddScore

Adds score to both the client and his team
============
*/
void AddScore( gentity_t *ent, vec3_t origin, int score ) {
	if ( !ent->client ) {
		return;
	}
	// no scoring during pre-match warmup
	if ( level.warmupTime ) {
		return;
	}
	// gun game: the score is the weapon level, set by G_GunGameKill
	if ( g_weaponMode.integer == WEAPONMODE_GUNGAME ) {
		return;
	}
	// show score plum
	ScorePlum(ent, origin, score);
	//
	ent->client->ps.persistant[PERS_SCORE] += score;
	// in freeze tag the team score counts rounds, not frags
	if ( g_gametype.integer == GT_TEAM && !G_FreezeTagActive() )
		level.teamScores[ ent->client->ps.persistant[PERS_TEAM] ] += score;
	CalculateRanks();
}

/*
=================
TossClientItems

Toss the weapon and powerups for the killed player
=================
*/
void TossClientItems( gentity_t *self ) {
	gitem_t		*item;
	int			weapon;
	float		angle;
	int			i;
	gentity_t	*drop;

	// weapon arenas: everyone already has the one weapon, nothing drops
	if ( g_weaponMode.integer ) {
		return;
	}

	// drop the weapon if not a gauntlet or machinegun
	weapon = self->s.weapon;

	// make a special check to see if they are changing to a new
	// weapon that isn't the mg or gauntlet.  Without this, a client
	// can pick up a weapon, be killed, and not drop the weapon because
	// their weapon change hasn't completed yet and they are still holding the MG.
	if ( weapon == WP_MACHINEGUN || weapon == WP_GRAPPLING_HOOK ) {
		if ( self->client->ps.weaponstate == WEAPON_DROPPING ) {
			weapon = self->client->pers.cmd.weapon;
		}
		if ( !( self->client->ps.stats[STAT_WEAPONS] & ( 1 << weapon ) ) ) {
			weapon = WP_NONE;
		}
	}

	if ( weapon > WP_MACHINEGUN && weapon != WP_GRAPPLING_HOOK && 
		self->client->ps.ammo[ weapon ] ) {
		// find the item type for this weapon
		item = BG_FindItemForWeapon( weapon );

		// spawn the item
		Drop_Item( self, item, 0 );
	}

	// drop all the powerups if not in teamplay
	if ( g_gametype.integer != GT_TEAM ) {
		angle = 45;
		for ( i = 1 ; i < PW_NUM_POWERUPS ; i++ ) {
			if ( self->client->ps.powerups[ i ] > level.time ) {
				item = BG_FindItemForPowerup( i );
				if ( !item ) {
					continue;
				}
				drop = Drop_Item( self, item, angle );
				// decide how many seconds it has left
				drop->count = ( self->client->ps.powerups[ i ] - level.time ) / 1000;
				if ( drop->count < 1 ) {
					drop->count = 1;
				}
				angle += 45;
			}
		}
	}
}

#ifdef MISSIONPACK

/*
=================
TossClientCubes
=================
*/
extern gentity_t	*neutralObelisk;

void TossClientCubes( gentity_t *self ) {
	gitem_t		*item;
	gentity_t	*drop;
	vec3_t		velocity;
	vec3_t		angles;
	vec3_t		origin;

	self->client->ps.generic1 = 0;

	// this should never happen but we should never
	// get the server to crash due to skull being spawned in
	if (!G_EntitiesFree()) {
		return;
	}

	if( self->client->sess.sessionTeam == TEAM_RED ) {
		item = BG_FindItem( "Red Cube" );
	}
	else {
		item = BG_FindItem( "Blue Cube" );
	}

	angles[YAW] = (float)(level.time % 360);
	angles[PITCH] = 0;	// always forward
	angles[ROLL] = 0;

	AngleVectors( angles, velocity, NULL, NULL );
	VectorScale( velocity, 150, velocity );
	velocity[2] += 200 + crandom() * 50;

	if( neutralObelisk ) {
		VectorCopy( neutralObelisk->s.pos.trBase, origin );
		origin[2] += 44;
	} else {
		VectorClear( origin ) ;
	}

	drop = LaunchItem( item, origin, velocity );

	drop->nextthink = level.time + g_cubeTimeout.integer * 1000;
	drop->think = G_FreeEntity;
	drop->spawnflags = self->client->sess.sessionTeam;
}


/*
=================
TossClientPersistantPowerups
=================
*/
void TossClientPersistantPowerups( gentity_t *ent ) {
	gentity_t	*powerup;

	if( !ent->client ) {
		return;
	}

	if( !ent->client->persistantPowerup ) {
		return;
	}

	powerup = ent->client->persistantPowerup;

	powerup->r.svFlags &= ~SVF_NOCLIENT;
	powerup->s.eFlags &= ~EF_NODRAW;
	powerup->r.contents = CONTENTS_TRIGGER;
	trap_LinkEntity( powerup );

	ent->client->ps.stats[STAT_PERSISTANT_POWERUP] = 0;
	ent->client->persistantPowerup = NULL;
}
#endif


/*
==================
LookAtKiller
==================
*/
void LookAtKiller( gentity_t *self, gentity_t *inflictor, gentity_t *attacker ) {
	vec3_t		dir;

	if ( attacker && attacker != self ) {
		VectorSubtract (attacker->s.pos.trBase, self->s.pos.trBase, dir);
	} else if ( inflictor && inflictor != self ) {
		VectorSubtract (inflictor->s.pos.trBase, self->s.pos.trBase, dir);
	} else {
		self->client->ps.stats[STAT_DEAD_YAW] = self->s.angles[YAW];
		return;
	}

	self->client->ps.stats[STAT_DEAD_YAW] = vectoyaw ( dir );
}

/*
==================
GibEntity
==================
*/
void GibEntity( gentity_t *self, int killer ) {
	gentity_t *ent;
	int i;

	//if this entity still has kamikaze
	if (self->s.eFlags & EF_KAMIKAZE) {
		// check if there is a kamikaze timer around for this owner
		for (i = 0; i < level.num_entities; i++) {
			ent = &g_entities[i];
			if (!ent->inuse)
				continue;
			if (ent->activator != self)
				continue;
			if (strcmp(ent->classname, "kamikaze timer"))
				continue;
			G_FreeEntity(ent);
			break;
		}
	}
	G_AddEvent( self, EV_GIB_PLAYER, killer );
	self->takedamage = qfalse;
	self->s.eType = ET_INVISIBLE;
	self->r.contents = 0;
}

/*
==================
body_die
==================
*/
void body_die( gentity_t *self, gentity_t *inflictor, gentity_t *attacker, int damage, int meansOfDeath ) {
	if ( self->health > GIB_HEALTH ) {
		return;
	}
	if ( !g_blood.integer ) {
		self->health = GIB_HEALTH+1;
		return;
	}

	GibEntity( self, 0 );
}


// these are just for logging, the client prints its own messages
char	*modNames[] = {
	"MOD_UNKNOWN",
	"MOD_SHOTGUN",
	"MOD_GAUNTLET",
	"MOD_MACHINEGUN",
	"MOD_GRENADE",
	"MOD_GRENADE_SPLASH",
	"MOD_ROCKET",
	"MOD_ROCKET_SPLASH",
	"MOD_PLASMA",
	"MOD_PLASMA_SPLASH",
	"MOD_RAILGUN",
	"MOD_LIGHTNING",
	"MOD_BFG",
	"MOD_BFG_SPLASH",
	"MOD_WATER",
	"MOD_SLIME",
	"MOD_LAVA",
	"MOD_CRUSH",
	"MOD_TELEFRAG",
	"MOD_FALLING",
	"MOD_SUICIDE",
	"MOD_TARGET_LASER",
	"MOD_TRIGGER_HURT",
#ifdef MISSIONPACK
	"MOD_NAIL",
	"MOD_CHAINGUN",
	"MOD_PROXIMITY_MINE",
	"MOD_KAMIKAZE",
	"MOD_JUICED",
#endif
	"MOD_GRAPPLE"
};

#ifdef MISSIONPACK
/*
==================
Kamikaze_DeathActivate
==================
*/
void Kamikaze_DeathActivate( gentity_t *ent ) {
	G_StartKamikaze(ent);
	G_FreeEntity(ent);
}

/*
==================
Kamikaze_DeathTimer
==================
*/
void Kamikaze_DeathTimer( gentity_t *self ) {
	gentity_t *ent;

	ent = G_Spawn();
	ent->classname = "kamikaze timer";
	VectorCopy(self->s.pos.trBase, ent->s.pos.trBase);
	ent->r.svFlags |= SVF_NOCLIENT;
	ent->think = Kamikaze_DeathActivate;
	ent->nextthink = level.time + 5 * 1000;

	ent->activator = self;
}

#endif

/*
==================
CheckAlmostCapture
==================
*/
void CheckAlmostCapture( gentity_t *self, gentity_t *attacker ) {
	gentity_t	*ent;
	vec3_t		dir;
	char		*classname;

	// if this player was carrying a flag
	if ( self->client->ps.powerups[PW_REDFLAG] ||
		self->client->ps.powerups[PW_BLUEFLAG] ||
		self->client->ps.powerups[PW_NEUTRALFLAG] ) {
		// get the goal flag this player should have been going for
		if ( g_gametype.integer == GT_CTF ) {
			if ( self->client->sess.sessionTeam == TEAM_BLUE ) {
				classname = "team_CTF_blueflag";
			}
			else {
				classname = "team_CTF_redflag";
			}
		}
		else {
			if ( self->client->sess.sessionTeam == TEAM_BLUE ) {
				classname = "team_CTF_redflag";
			}
			else {
				classname = "team_CTF_blueflag";
			}
		}
		ent = NULL;
		do
		{
			ent = G_Find(ent, FOFS(classname), classname);
		} while (ent && (ent->flags & FL_DROPPED_ITEM));
		// if we found the destination flag and it's not picked up
		if (ent && !(ent->r.svFlags & SVF_NOCLIENT) ) {
			// if the player was *very* close
			VectorSubtract( self->client->ps.origin, ent->s.origin, dir );
			if ( VectorLength(dir) < 200 ) {
				self->client->ps.persistant[PERS_PLAYEREVENTS] ^= PLAYEREVENT_HOLYSHIT;
				if ( attacker->client ) {
					attacker->client->ps.persistant[PERS_PLAYEREVENTS] ^= PLAYEREVENT_HOLYSHIT;
				}
			}
		}
	}
}

/*
==================
CheckAlmostScored
==================
*/
void CheckAlmostScored( gentity_t *self, gentity_t *attacker ) {
	gentity_t	*ent;
	vec3_t		dir;
	char		*classname;

	// if the player was carrying cubes
	if ( self->client->ps.generic1 ) {
		if ( self->client->sess.sessionTeam == TEAM_BLUE ) {
			classname = "team_redobelisk";
		}
		else {
			classname = "team_blueobelisk";
		}
		ent = G_Find(NULL, FOFS(classname), classname);
		// if we found the destination obelisk
		if ( ent ) {
			// if the player was *very* close
			VectorSubtract( self->client->ps.origin, ent->s.origin, dir );
			if ( VectorLength(dir) < 200 ) {
				self->client->ps.persistant[PERS_PLAYEREVENTS] ^= PLAYEREVENT_HOLYSHIT;
				if ( attacker->client ) {
					attacker->client->ps.persistant[PERS_PLAYEREVENTS] ^= PLAYEREVENT_HOLYSHIT;
				}
			}
		}
	}
}

/*
==================
player_die
==================
*/
void player_die( gentity_t *self, gentity_t *inflictor, gentity_t *attacker, int damage, int meansOfDeath ) {
	gentity_t	*ent;
	int			anim;
	int			contents;
	int			killer;
	int			i;
	char		*killerName, *obit;

	if ( self->client->ps.pm_type == PM_DEAD ) {
		return;
	}

	if ( level.intermissiontime ) {
		return;
	}

	// check for an almost capture
	CheckAlmostCapture( self, attacker );
	// check for a player that almost brought in cubes
	CheckAlmostScored( self, attacker );

	if (self->client && self->client->hook) {
		Weapon_HookFree(self->client->hook);
	}
#ifdef MISSIONPACK
	if ((self->client->ps.eFlags & EF_TICKING) && self->activator) {
		self->client->ps.eFlags &= ~EF_TICKING;
		self->activator->think = G_FreeEntity;
		self->activator->nextthink = level.time;
	}
#endif
	self->client->ps.pm_type = PM_DEAD;

	if ( attacker ) {
		killer = attacker->s.number;
		if ( attacker->client ) {
			killerName = attacker->client->pers.netname;
		} else {
			killerName = "<non-client>";
		}
	} else {
		killer = ENTITYNUM_WORLD;
		killerName = "<world>";
	}

	if ( killer < 0 || killer >= MAX_CLIENTS ) {
		killer = ENTITYNUM_WORLD;
		killerName = "<world>";
	}

	if ( meansOfDeath < 0 || meansOfDeath >= ARRAY_LEN( modNames ) ) {
		obit = "<bad obituary>";
	} else {
		obit = modNames[meansOfDeath];
	}

	G_LogPrintf("Kill: %i %i %i: %s killed %s by %s\n", 
		killer, self->s.number, meansOfDeath, killerName, 
		self->client->pers.netname, obit );

	// broadcast the death event to everyone
	ent = G_TempEntity( self->r.currentOrigin, EV_OBITUARY );
	ent->s.eventParm = meansOfDeath;
	ent->s.otherEntityNum = self->s.number;
	ent->s.otherEntityNum2 = killer;
	ent->r.svFlags = SVF_BROADCAST;	// send to everyone

	self->enemy = attacker;

	self->client->ps.persistant[PERS_KILLED]++;

	if (attacker && attacker->client) {
		attacker->client->lastkilled_client = self->s.number;

		if ( attacker == self || OnSameTeam (self, attacker ) ) {
			AddScore( attacker, self->r.currentOrigin, -1 );
		} else {
			AddScore( attacker, self->r.currentOrigin, 1 );
			G_NotifyKillPost( attacker, self, meansOfDeath );

			if( meansOfDeath == MOD_GAUNTLET ) {
				
				// play humiliation on player
				attacker->client->ps.persistant[PERS_GAUNTLET_FRAG_COUNT]++;

				// add the sprite over the player's head
				attacker->client->ps.eFlags &= ~(EF_AWARD_IMPRESSIVE | EF_AWARD_EXCELLENT | EF_AWARD_GAUNTLET | EF_AWARD_ASSIST | EF_AWARD_DEFEND | EF_AWARD_CAP );
				attacker->client->ps.eFlags |= EF_AWARD_GAUNTLET;
				attacker->client->rewardTime = level.time + REWARD_SPRITE_TIME;

				// also play humiliation on target
				self->client->ps.persistant[PERS_PLAYEREVENTS] ^= PLAYEREVENT_GAUNTLETREWARD;
			}

			// check for two kills in a short amount of time
			// if this is close enough to the last kill, give a reward sound
			if ( level.time - attacker->client->lastKillTime < CARNAGE_REWARD_TIME ) {
				// play excellent on player
				attacker->client->ps.persistant[PERS_EXCELLENT_COUNT]++;

				// add the sprite over the player's head
				attacker->client->ps.eFlags &= ~(EF_AWARD_IMPRESSIVE | EF_AWARD_EXCELLENT | EF_AWARD_GAUNTLET | EF_AWARD_ASSIST | EF_AWARD_DEFEND | EF_AWARD_CAP );
				attacker->client->ps.eFlags |= EF_AWARD_EXCELLENT;
				attacker->client->rewardTime = level.time + REWARD_SPRITE_TIME;
			}
			attacker->client->lastKillTime = level.time;

		}
	} else {
		AddScore( self, self->r.currentOrigin, -1 );
	}

	if ( g_weaponMode.integer == WEAPONMODE_GUNGAME ) {
		G_GunGameKill( self, attacker, meansOfDeath );
	}

	// Add team bonuses
	Team_FragBonuses(self, inflictor, attacker);

	// if I committed suicide, the flag does not fall, it returns.
	if (meansOfDeath == MOD_SUICIDE) {
		if ( self->client->ps.powerups[PW_NEUTRALFLAG] ) {		// only happens in One Flag CTF
			Team_ReturnFlag( TEAM_FREE );
			self->client->ps.powerups[PW_NEUTRALFLAG] = 0;
		}
		else if ( self->client->ps.powerups[PW_REDFLAG] ) {		// only happens in standard CTF
			Team_ReturnFlag( TEAM_RED );
			self->client->ps.powerups[PW_REDFLAG] = 0;
		}
		else if ( self->client->ps.powerups[PW_BLUEFLAG] ) {	// only happens in standard CTF
			Team_ReturnFlag( TEAM_BLUE );
			self->client->ps.powerups[PW_BLUEFLAG] = 0;
		}
	}

	TossClientItems( self );
#ifdef MISSIONPACK
	TossClientPersistantPowerups( self );
	if( g_gametype.integer == GT_HARVESTER ) {
		TossClientCubes( self );
	}
#endif

	Cmd_Score_f( self );		// show scores
	// send updated scores to any clients that are following this one,
	// or they would get stale scoreboards
	for ( i = 0 ; i < level.maxclients ; i++ ) {
		gclient_t	*client;

		client = &level.clients[i];
		if ( client->pers.connected != CON_CONNECTED ) {
			continue;
		}
		if ( client->sess.sessionTeam != TEAM_SPECTATOR ) {
			continue;
		}
		if ( client->sess.spectatorClient == self->s.number ) {
			Cmd_Score_f( g_entities + i );
		}
	}

	self->takedamage = qtrue;	// can still be gibbed

	self->s.weapon = WP_NONE;
	self->s.powerups = 0;
	self->r.contents = CONTENTS_CORPSE;

	self->s.angles[0] = 0;
	self->s.angles[2] = 0;
	LookAtKiller (self, inflictor, attacker);

	VectorCopy( self->s.angles, self->client->ps.viewangles );

	self->s.loopSound = 0;

	self->r.maxs[2] = DEAD_HEIGHT;

	// don't allow respawn until the death anim is done
	// g_forcerespawn may force spawning at some later time
	self->client->respawnTime = level.time + 1700;

	// remove powerups
	memset( self->client->ps.powerups, 0, sizeof(self->client->ps.powerups) );

	// never gib in a nodrop
	contents = trap_PointContents( self->r.currentOrigin, -1 );

	if ( (self->health <= GIB_HEALTH && !(contents & CONTENTS_NODROP) && g_blood.integer) || meansOfDeath == MOD_SUICIDE) {
		// gib death
		GibEntity( self, killer );
	} else {
		// normal death
		static int lastDeath;

		switch ( lastDeath ) {
		case 0:
			anim = BOTH_DEATH1;
			break;
		case 1:
			anim = BOTH_DEATH2;
			break;
		case 2:
		default:
			anim = BOTH_DEATH3;
			break;
		}

		// for the no-blood option, we need to prevent the health
		// from going to gib level
		if ( self->health <= GIB_HEALTH ) {
			self->health = GIB_HEALTH+1;
		}

		self->client->ps.legsAnim = 
			( ( self->client->ps.legsAnim & ANIM_TOGGLEBIT ) ^ ANIM_TOGGLEBIT ) | anim;
		self->client->ps.torsoAnim = 
			( ( self->client->ps.torsoAnim & ANIM_TOGGLEBIT ) ^ ANIM_TOGGLEBIT ) | anim;

		G_AddEvent( self, EV_DEATH1 + lastDeath, killer );

		// the body can still be gibbed
		self->die = body_die;

		// globally cycle through the different death animations
		lastDeath = ( lastDeath + 1 ) % 3;

#ifdef MISSIONPACK
		if (self->s.eFlags & EF_KAMIKAZE) {
			Kamikaze_DeathTimer( self );
		}
#endif
	}

	trap_LinkEntity (self);

}


/*
================
CheckArmor
================
*/
int CheckArmor (gentity_t *ent, int damage, int dflags)
{
	gclient_t	*client;
	int			save;
	int			count;

	if (!damage)
		return 0;

	client = ent->client;

	if (!client)
		return 0;

	if (dflags & DAMAGE_NO_ARMOR)
		return 0;

	// armor
	count = client->ps.stats[STAT_ARMOR];
	save = ceil( damage * ARMOR_PROTECTION );
	if (save >= count)
		save = count;

	if (!save)
		return 0;

	client->ps.stats[STAT_ARMOR] -= save;

	return save;
}

/*
================
RaySphereIntersections
================
*/
int RaySphereIntersections( vec3_t origin, float radius, vec3_t point, vec3_t dir, vec3_t intersections[2] ) {
	float b, c, d, t;

	//	| origin - (point + t * dir) | = radius
	//	a = dir[0]^2 + dir[1]^2 + dir[2]^2;
	//	b = 2 * (dir[0] * (point[0] - origin[0]) + dir[1] * (point[1] - origin[1]) + dir[2] * (point[2] - origin[2]));
	//	c = (point[0] - origin[0])^2 + (point[1] - origin[1])^2 + (point[2] - origin[2])^2 - radius^2;

	// normalize dir so a = 1
	VectorNormalize(dir);
	b = 2 * (dir[0] * (point[0] - origin[0]) + dir[1] * (point[1] - origin[1]) + dir[2] * (point[2] - origin[2]));
	c = (point[0] - origin[0]) * (point[0] - origin[0]) +
		(point[1] - origin[1]) * (point[1] - origin[1]) +
		(point[2] - origin[2]) * (point[2] - origin[2]) -
		radius * radius;

	d = b * b - 4 * c;
	if (d > 0) {
		t = (- b + sqrt(d)) / 2;
		VectorMA(point, t, dir, intersections[0]);
		t = (- b - sqrt(d)) / 2;
		VectorMA(point, t, dir, intersections[1]);
		return 2;
	}
	else if (d == 0) {
		t = (- b ) / 2;
		VectorMA(point, t, dir, intersections[0]);
		return 1;
	}
	return 0;
}

#ifdef MISSIONPACK
/*
================
G_InvulnerabilityEffect
================
*/
int G_InvulnerabilityEffect( gentity_t *targ, vec3_t dir, vec3_t point, vec3_t impactpoint, vec3_t bouncedir ) {
	gentity_t	*impact;
	vec3_t		intersections[2], vec;
	int			n;

	if ( !targ->client ) {
		return qfalse;
	}
	VectorCopy(dir, vec);
	VectorInverse(vec);
	n = RaySphereIntersections( targ->client->ps.origin, INVUL_RADIUS, point, vec, intersections);
	if (n > 0) {
		impact = G_TempEntity( targ->client->ps.origin, EV_INVUL_IMPACT );
		VectorSubtract(intersections[0], targ->client->ps.origin, vec);
		vectoangles(vec, impact->s.angles);
		impact->s.angles[0] += 90;
		if (impact->s.angles[0] > 360)
			impact->s.angles[0] -= 360;
		if ( impactpoint ) {
			VectorCopy( intersections[0], impactpoint );
		}
		if ( bouncedir ) {
			VectorCopy( vec, bouncedir );
			VectorNormalize( bouncedir );
		}
		return qtrue;
	}
	else {
		return qfalse;
	}
}
#endif
/*
============
G_Damage

targ		entity that is being damaged
inflictor	entity that is causing the damage
attacker	entity that caused the inflictor to damage targ
	example: targ=monster, inflictor=rocket, attacker=player

dir			direction of the attack for knockback
point		point at which the damage is being inflicted, used for headshots
damage		amount of damage being inflicted
knockback	force to be applied against targ as a result of the damage

inflictor, attacker, dir, and point can be NULL for environmental effects

dflags		these flags are used to control how T_Damage works
	DAMAGE_RADIUS			damage was indirect (from a nearby explosion)
	DAMAGE_NO_ARMOR			armor does not protect from this damage
	DAMAGE_NO_KNOCKBACK		do not affect velocity, just view angles
	DAMAGE_NO_PROTECTION	kills godmode, armor, everything
============
*/

void G_Damage( gentity_t *targ, gentity_t *inflictor, gentity_t *attacker,
			   vec3_t dir, vec3_t point, int damage, int dflags, int mod ) {
	gclient_t	*client;
	int			take;
	int			asave;
	int			knockback;
	int			max;
#ifdef MISSIONPACK
	vec3_t		bouncedir, impactpoint;
#endif

	if (!targ->takedamage) {
		return;
	}

	// frozen players (freeze tag) are out of reach until thawed
	if ( targ->client && targ->client->frozen ) {
		return;
	}

	// the intermission has already been qualified for, so don't
	// allow any extra scoring
	if ( level.intermissionQueued ) {
		return;
	}
#ifdef MISSIONPACK
	if ( targ->client && mod != MOD_JUICED) {
		if ( targ->client->invulnerabilityTime > level.time) {
			if ( dir && point ) {
				G_InvulnerabilityEffect( targ, dir, point, impactpoint, bouncedir );
			}
			return;
		}
	}
#endif
	if ( !inflictor ) {
		inflictor = &g_entities[ENTITYNUM_WORLD];
	}
	if ( !attacker ) {
		attacker = &g_entities[ENTITYNUM_WORLD];
	}

	// shootable doors / buttons don't actually have any health
	if ( targ->s.eType == ET_MOVER ) {
		if ( targ->use && targ->moverState == MOVER_POS1 ) {
			targ->use( targ, inflictor, attacker );
		}
		return;
	}
#ifdef MISSIONPACK
	if( g_gametype.integer == GT_OBELISK && CheckObeliskAttack( targ, attacker ) ) {
		return;
	}
#endif
	// reduce damage by the attacker's handicap value
	// unless they are rocket jumping
	if ( attacker->client && attacker != targ ) {
		max = attacker->client->ps.stats[STAT_MAX_HEALTH];
#ifdef MISSIONPACK
		if( bg_itemlist[attacker->client->ps.stats[STAT_PERSISTANT_POWERUP]].giTag == PW_GUARD ) {
			max /= 2;
		}
#endif
		damage = damage * max / 100;
	}

	// instagib: any railgun hit from another player kills outright
	if ( g_weaponMode.integer == WEAPONMODE_INSTAGIB && mod == MOD_RAILGUN
		&& attacker->client && attacker != targ ) {
		damage = 1000;
	}

	client = targ->client;

	if ( client ) {
		if ( client->noclip ) {
			return;
		}
	}

	// spawn protection (weapon arenas): other players can neither hurt nor
	// push someone who just spawned and has not fired yet
	if ( client && client->spawnProtectUntil > level.time
		&& attacker->client && attacker != targ ) {
		if ( g_debugDamage.integer ) {
			G_LogPrintf( "SpawnProtect: %i %i: %s blocked\n", (int)( attacker - g_entities ),
				(int)( targ - g_entities ), client->pers.netname );
		}
		return;
	}

	if ( !dir ) {
		dflags |= DAMAGE_NO_KNOCKBACK;
	} else {
		VectorNormalize(dir);
	}

	knockback = damage;
	if ( knockback > 200 ) {
		knockback = 200;
	}
	if ( targ->flags & FL_NO_KNOCKBACK ) {
		knockback = 0;
	}
	if ( dflags & DAMAGE_NO_KNOCKBACK ) {
		knockback = 0;
	}

	// figure momentum add, even if the damage won't be taken
	if ( knockback && targ->client ) {
		vec3_t	kvel;
		float	mass;

		mass = 200;

		VectorScale (dir, g_knockback.value * (float)knockback / mass, kvel);
		VectorAdd (targ->client->ps.velocity, kvel, targ->client->ps.velocity);

		// set the timer so that the other client can't cancel
		// out the movement immediately
		if ( !targ->client->ps.pm_time ) {
			int		t;

			t = knockback * 2;
			if ( t < 50 ) {
				t = 50;
			}
			if ( t > 200 ) {
				t = 200;
			}
			targ->client->ps.pm_time = t;
			targ->client->ps.pm_flags |= PMF_TIME_KNOCKBACK;
		}
	}

	// check for completely getting out of the damage
	if ( !(dflags & DAMAGE_NO_PROTECTION) ) {

		// if TF_NO_FRIENDLY_FIRE is set, don't do damage to the target
		// if the attacker was on the same team
#ifdef MISSIONPACK
		if ( mod != MOD_JUICED && targ != attacker && !(dflags & DAMAGE_NO_TEAM_PROTECTION) && OnSameTeam (targ, attacker)  ) {
#else	
		if ( targ != attacker && OnSameTeam (targ, attacker)  ) {
#endif
			if ( !g_friendlyFire.integer ) {
				return;
			}
		}
#ifdef MISSIONPACK
		if (mod == MOD_PROXIMITY_MINE) {
			if (inflictor && inflictor->parent && OnSameTeam(targ, inflictor->parent)) {
				return;
			}
			if (targ == attacker) {
				return;
			}
		}
#endif

		// check for godmode
		if ( targ->flags & FL_GODMODE ) {
			return;
		}
	}

	// battlesuit protects from all radius damage (but takes knockback)
	// and protects 50% against all damage
	if ( client && client->ps.powerups[PW_BATTLESUIT] ) {
		G_AddEvent( targ, EV_POWERUP_BATTLESUIT, 0 );
		if ( ( dflags & DAMAGE_RADIUS ) || ( mod == MOD_FALLING ) ) {
			return;
		}
		damage *= 0.5;
	}

	// add to the attacker's hit counter (if the target isn't a general entity like a prox mine)
	if ( attacker->client && client
			&& targ != attacker && targ->health > 0
			&& targ->s.eType != ET_MISSILE
			&& targ->s.eType != ET_GENERAL) {
		if ( OnSameTeam( targ, attacker ) ) {
			attacker->client->ps.persistant[PERS_HITS]--;
		} else {
			attacker->client->ps.persistant[PERS_HITS]++;
		}
		attacker->client->ps.persistant[PERS_ATTACKEE_ARMOR] = (targ->health<<8)|(client->ps.stats[STAT_ARMOR]);
	}

	// always give half damage if hurting self
	// calculated after knockback, so rocket jumping works
	if ( targ == attacker) {
		// g_selfDamage 0: the knockback above is all you get (not /kill)
		if ( !g_selfDamage.integer && !( dflags & DAMAGE_NO_PROTECTION ) ) {
			if ( g_debugDamage.integer ) {
				G_LogPrintf( "SelfDamage: %i %i: %s blocked %i\n", (int)( targ - g_entities ), mod,
					client ? client->pers.netname : "", damage );
			}
			return;
		}
		damage *= 0.5;
	}

	if ( damage < 1 ) {
		damage = 1;
	}
	take = damage;

	// save some from armor
	asave = CheckArmor (targ, take, dflags);
	take -= asave;

	if ( g_debugDamage.integer ) {
		G_Printf( "%i: client:%i health:%i damage:%i armor:%i\n", level.time, targ->s.number,
			targ->health, take, asave );
	}

	// vampire mutator: the attacker heals by a share of the health taken
	if ( g_vampire.value > 0 && client && take > 0 && attacker->client && attacker != targ
		&& !OnSameTeam( targ, attacker ) && attacker->health > 0 && targ->health > 0 ) {
		int heal = (int)( ( take < targ->health ? take : targ->health ) * g_vampire.value );

		if ( heal > 0 && attacker->health < VAMPIRE_MAX_HEALTH ) {
			attacker->health += heal;
			if ( attacker->health > VAMPIRE_MAX_HEALTH ) {
				attacker->health = VAMPIRE_MAX_HEALTH;
			}
			attacker->client->ps.stats[STAT_HEALTH] = attacker->health;
			if ( g_debugDamage.integer ) {
				G_LogPrintf( "Vampire: %i %i: healed %i\n", (int)( attacker - g_entities ), heal, attacker->health );
			}
		}
	}

	// add to the damage inflicted on a player this frame
	// the total will be turned into screen blends and view angle kicks
	// at the end of the frame
	if ( client ) {
		if ( attacker ) {
			client->ps.persistant[PERS_ATTACKER] = attacker->s.number;
		} else {
			client->ps.persistant[PERS_ATTACKER] = ENTITYNUM_WORLD;
		}
		client->damage_armor += asave;
		client->damage_blood += take;
		client->damage_knockback += knockback;
		if ( dir ) {
			VectorCopy ( dir, client->damage_from );
			client->damage_fromWorld = qfalse;
		} else {
			VectorCopy ( targ->r.currentOrigin, client->damage_from );
			client->damage_fromWorld = qtrue;
		}
	}

	// See if it's the player hurting the emeny flag carrier
#ifdef MISSIONPACK
	if( g_gametype.integer == GT_CTF || g_gametype.integer == GT_1FCTF ) {
#else	
	if( g_gametype.integer == GT_CTF) {
#endif
		Team_CheckHurtCarrier(targ, attacker);
	}

	if (targ->client) {
		// set the last client who damaged the target
		targ->client->lasthurt_client = attacker->s.number;
		targ->client->lasthurt_mod = mod;
	}

	// do the damage
	if (take) {
		targ->health = targ->health - take;
		if ( targ->client ) {
			targ->client->ps.stats[STAT_HEALTH] = targ->health;
		}
			
		if ( targ->health <= 0 ) {
			// freeze tag: an enemy's kill freezes instead (world/self deaths are real)
			if ( client && G_FreezeTagActive() && attacker->client && attacker != targ
				&& !OnSameTeam( targ, attacker ) && !level.freezeRoundEnd ) {
				G_FreezePlayer( targ, attacker, mod );
				return;
			}
			if ( client )
				targ->flags |= FL_NO_KNOCKBACK;

			if (targ->health < -999)
				targ->health = -999;

			targ->enemy = attacker;
			targ->die (targ, inflictor, attacker, take, mod);
			return;
		} else if ( targ->pain ) {
			targ->pain (targ, attacker, take);
		}
	}

}


/*
============
CanDamage

Returns qtrue if the inflictor can directly damage the target.  Used for
explosions and melee attacks.
============
*/
qboolean CanDamage (gentity_t *targ, vec3_t origin) {
	vec3_t	dest;
	trace_t	tr;
	vec3_t	midpoint;
	vec3_t	offsetmins = {-15, -15, -15};
	vec3_t	offsetmaxs = {15, 15, 15};

	// use the midpoint of the bounds instead of the origin, because
	// bmodels may have their origin is 0,0,0
	VectorAdd (targ->r.absmin, targ->r.absmax, midpoint);
	VectorScale (midpoint, 0.5, midpoint);

	VectorCopy(midpoint, dest);
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0 || tr.entityNum == targ->s.number)
		return qtrue;

	// this should probably check in the plane of projection, 
	// rather than in world coordinate
	VectorCopy(midpoint, dest);
	dest[0] += offsetmaxs[0];
	dest[1] += offsetmaxs[1];
	dest[2] += offsetmaxs[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmaxs[0];
	dest[1] += offsetmins[1];
	dest[2] += offsetmaxs[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmins[0];
	dest[1] += offsetmaxs[1];
	dest[2] += offsetmaxs[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmins[0];
	dest[1] += offsetmins[1];
	dest[2] += offsetmaxs[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmaxs[0];
	dest[1] += offsetmaxs[1];
	dest[2] += offsetmins[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmaxs[0];
	dest[1] += offsetmins[1];
	dest[2] += offsetmins[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmins[0];
	dest[1] += offsetmaxs[1];
	dest[2] += offsetmins[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	VectorCopy(midpoint, dest);
	dest[0] += offsetmins[0];
	dest[1] += offsetmins[1];
	dest[2] += offsetmins[2];
	trap_Trace(&tr, origin, vec3_origin, vec3_origin, dest, ENTITYNUM_NONE, MASK_SOLID);

	if (tr.fraction == 1.0)
		return qtrue;

	return qfalse;
}


/*
============
G_RadiusDamage
============
*/
qboolean G_RadiusDamage ( vec3_t origin, gentity_t *attacker, float damage, float radius,
					 gentity_t *ignore, int mod) {
	float		points, dist;
	gentity_t	*ent;
	int			entityList[MAX_GENTITIES];
	int			numListedEntities;
	vec3_t		mins, maxs;
	vec3_t		v;
	vec3_t		dir;
	int			i, e;
	qboolean	hitClient = qfalse;

	if ( radius < 1 ) {
		radius = 1;
	}

	for ( i = 0 ; i < 3 ; i++ ) {
		mins[i] = origin[i] - radius;
		maxs[i] = origin[i] + radius;
	}

	numListedEntities = trap_EntitiesInBox( mins, maxs, entityList, MAX_GENTITIES );

	for ( e = 0 ; e < numListedEntities ; e++ ) {
		ent = &g_entities[entityList[ e ]];

		if (ent == ignore)
			continue;
		if (!ent->takedamage)
			continue;

		// find the distance from the edge of the bounding box
		for ( i = 0 ; i < 3 ; i++ ) {
			if ( origin[i] < ent->r.absmin[i] ) {
				v[i] = ent->r.absmin[i] - origin[i];
			} else if ( origin[i] > ent->r.absmax[i] ) {
				v[i] = origin[i] - ent->r.absmax[i];
			} else {
				v[i] = 0;
			}
		}

		dist = VectorLength( v );
		if ( dist >= radius ) {
			continue;
		}

		points = damage * ( 1.0 - dist / radius );

		if( CanDamage (ent, origin) ) {
			if( LogAccuracyHit( ent, attacker ) ) {
				hitClient = qtrue;
			}
			VectorSubtract (ent->r.currentOrigin, origin, dir);
			// push the center of mass higher than the origin so players
			// get knocked into the air more
			dir[2] += 24;
			G_Damage (ent, NULL, attacker, dir, origin, (int)points, DAMAGE_RADIUS, mod);
		}
	}

	return hitClient;
}


/*
=============================================================================

FREEZE TAG (g_freeze, team deathmatch)

A kill by an enemy freezes the victim in place instead: frozen players
cannot move, shoot or be hurt, and wear a battle suit shell. A teammate who
stays within FREEZE_THAW_RANGE for g_thawTime seconds thaws them. When every
player of a team is frozen the other team wins the round (one team point),
and after a short pause everyone respawns for the next round; the fraglimit
counts rounds. Deaths to the world or yourself are ordinary deaths.

=============================================================================
*/

#define FREEZE_THAW_RANGE	100
#define FREEZE_ROUND_PAUSE	3000

qboolean G_FreezeTagActive( void ) {
	return g_freeze.integer && g_gametype.integer == GT_TEAM;
}

void G_FreezePlayer( gentity_t *self, gentity_t *attacker, int meansOfDeath ) {
	gclient_t	*cl = self->client;
	gentity_t	*ev;
	const char	*obit;

	obit = ( meansOfDeath >= 0 && meansOfDeath < ARRAY_LEN( modNames ) ) ? modNames[meansOfDeath] : "<bad obituary>";
	// same log line as a kill, so the frag counts in the stats
	G_LogPrintf( "Kill: %i %i %i: %s killed %s by %s\n", attacker->s.number, self->s.number, meansOfDeath,
		attacker->client->pers.netname, cl->pers.netname, obit );
	G_LogPrintf( "Freeze: %i %i: %s froze %s\n", attacker->s.number, self->s.number,
		attacker->client->pers.netname, cl->pers.netname );

	ev = G_TempEntity( self->r.currentOrigin, EV_OBITUARY );
	ev->s.eventParm = meansOfDeath;
	ev->s.otherEntityNum = self->s.number;
	ev->s.otherEntityNum2 = attacker->s.number;
	ev->r.svFlags = SVF_BROADCAST;

	if ( !OnSameTeam( self, attacker ) ) {
		AddScore( attacker, self->r.currentOrigin, 1 );
	}
	cl->ps.persistant[PERS_KILLED]++;

	cl->frozen = qtrue;
	cl->thawProgress = 0;
	self->health = cl->ps.stats[STAT_HEALTH] = 1;
	VectorClear( cl->ps.velocity );
	memset( cl->ps.powerups, 0, sizeof( cl->ps.powerups ) );
	cl->ps.powerups[PW_BATTLESUIT] = level.time + 0x7fffff;	// the "frozen" shell
	// the game client shows FROZEN and the thaw bar from STAT_THAW
}

static void G_ThawPlayer( gentity_t *ent, gentity_t *by ) {
	gclient_t *cl = ent->client;

	cl->frozen = qfalse;
	cl->thawProgress = 0;
	cl->ps.powerups[PW_BATTLESUIT] = 0;
	ent->health = cl->ps.stats[STAT_HEALTH] = cl->ps.stats[STAT_MAX_HEALTH];
	if ( by ) {
		G_LogPrintf( "Thaw: %i %i: %s thawed %s\n", (int)( by - g_entities ), (int)( ent - g_entities ),
			by->client->pers.netname, cl->pers.netname );
		AddScore( by, ent->r.currentOrigin, 1 );
		trap_SendServerCommand( ent - g_entities, va( "cp \"^7thawed by %s\"", by->client->pers.netname ) );
		trap_SendServerCommand( by - g_entities, va( "cp \"^7you thawed %s\"", cl->pers.netname ) );
	}
}

static void G_FreezeTagNewRound( void ) {
	gentity_t	*ent;
	int			i;

	level.freezeRoundEnd = 0;
	for ( i = 0; i < level.maxclients; i++ ) {
		ent = &g_entities[i];
		if ( !ent->inuse || !ent->client || ent->client->pers.connected != CON_CONNECTED
			|| ent->client->sess.sessionTeam == TEAM_SPECTATOR ) {
			continue;
		}
		ClientSpawn( ent );		// clears frozen, full health, spawn weapons
	}
	// the game client shows the round banner and plays "fight"
	trap_SendServerCommand( -1, va( "ftstart %i", level.teamScores[TEAM_RED] + level.teamScores[TEAM_BLUE] + 1 ) );
}

void G_FreezeTagFrame( void ) {
	gentity_t	*ent, *mate, *thawer;
	gclient_t	*cl;
	int			i, j, team, players[TEAM_NUM_TEAMS], frozen[TEAM_NUM_TEAMS], winner, loser;
	int			msec = level.time - level.previousTime;

	if ( !G_FreezeTagActive() || level.intermissiontime || level.warmupTime ) {
		return;
	}
	if ( level.freezeRoundEnd ) {
		if ( level.time >= level.freezeRoundEnd ) {
			G_FreezeTagNewRound();
		}
		return;
	}

	memset( players, 0, sizeof( players ) );
	memset( frozen, 0, sizeof( frozen ) );
	for ( i = 0; i < level.maxclients; i++ ) {
		ent = &g_entities[i];
		cl = ent->client;
		if ( !ent->inuse || !cl || cl->pers.connected != CON_CONNECTED ) {
			continue;
		}
		cl->ps.stats[STAT_THAW] = 0;
		cl->ps.stats[STAT_THAWING] = 0;
		team = cl->sess.sessionTeam;
		if ( team != TEAM_RED && team != TEAM_BLUE ) {
			continue;
		}
		players[team]++;
		if ( !cl->frozen ) {
			continue;
		}
		frozen[team]++;
		cl->ps.stats[STAT_THAW] = 1;

		// a living teammate close by thaws over g_thawTime seconds
		thawer = NULL;
		for ( j = 0; j < level.maxclients; j++ ) {
			mate = &g_entities[j];
			if ( j == i || !mate->inuse || !mate->client || mate->client->pers.connected != CON_CONNECTED
				|| mate->client->sess.sessionTeam != team || mate->client->frozen || mate->health <= 0 ) {
				continue;
			}
			if ( Distance( mate->r.currentOrigin, ent->r.currentOrigin ) < FREEZE_THAW_RANGE ) {
				thawer = mate;
				break;
			}
		}
		if ( !thawer ) {
			cl->thawProgress = 0;
			continue;
		}
		cl->thawProgress += msec;
		if ( cl->thawProgress >= g_thawTime.integer * 1000 ) {
			G_ThawPlayer( ent, thawer );
			cl->ps.stats[STAT_THAW] = 0;
			frozen[team]--;
		} else {
			// both see the bar: the frozen player, and the one thawing them
			int pct = cl->thawProgress * 100 / ( g_thawTime.integer * 1000 );

			cl->ps.stats[STAT_THAW] = 1 + pct;
			if ( thawer->client->ps.stats[STAT_THAWING] < 1 + pct ) {
				thawer->client->ps.stats[STAT_THAWING] = 1 + pct;
			}
		}
	}

	// team counts for everyone's HUD (spectators see the followed player's)
	for ( i = 0; i < level.maxclients; i++ ) {
		ent = &g_entities[i];
		if ( !ent->inuse || !ent->client ) {
			continue;
		}
		ent->client->ps.stats[STAT_FT_RED] = ( players[TEAM_RED] - frozen[TEAM_RED] ) | ( players[TEAM_RED] << 8 );
		ent->client->ps.stats[STAT_FT_BLUE] = ( players[TEAM_BLUE] - frozen[TEAM_BLUE] ) | ( players[TEAM_BLUE] << 8 );
	}

	// a team with everyone frozen loses the round
	winner = loser = 0;
	if ( players[TEAM_RED] && players[TEAM_BLUE] ) {
		if ( frozen[TEAM_RED] == players[TEAM_RED] ) {
			winner = TEAM_BLUE;
			loser = TEAM_RED;
		} else if ( frozen[TEAM_BLUE] == players[TEAM_BLUE] ) {
			winner = TEAM_RED;
			loser = TEAM_BLUE;
		}
	}
	if ( !winner ) {
		return;
	}
	level.teamScores[winner]++;
	CalculateRanks();
	G_LogPrintf( "FreezeRound: %s wins (%i - %i)\n", TeamName( winner ),
		level.teamScores[TEAM_RED], level.teamScores[TEAM_BLUE] );
	// the game client shows the banner (winner, score) and plays the team sound
	trap_SendServerCommand( -1, va( "ftround %i %i %i %i", winner, loser,
		level.teamScores[TEAM_RED], level.teamScores[TEAM_BLUE] ) );
	level.freezeRoundEnd = level.time + FREEZE_ROUND_PAUSE;
}

/*
============
G_MutatorsFrame

g_grapple and g_quadAll are handed out on spawn; when the admin toggles them
mid-match, living players get (or lose) them right away instead.
============
*/
void G_MutatorsFrame( void ) {
	static int	grapple = -1, quad = -1;
	gentity_t	*ent;
	gclient_t	*cl;
	int			i, w;

	if ( grapple == g_grapple.integer && quad == g_quadAll.integer ) {
		return;
	}
	if ( grapple == -1 ) {			// first frame: spawns already handled it
		grapple = g_grapple.integer;
		quad = g_quadAll.integer;
		return;
	}
	for ( i = 0, ent = g_entities; i < level.maxclients; i++, ent++ ) {
		cl = ent->client;
		if ( !ent->inuse || !cl || cl->sess.sessionTeam == TEAM_SPECTATOR || ent->health <= 0 ) {
			continue;
		}
		if ( grapple != g_grapple.integer ) {
			if ( g_grapple.integer ) {
				cl->ps.stats[STAT_WEAPONS] |= ( 1 << WP_GRAPPLING_HOOK );
			} else {
				cl->ps.stats[STAT_WEAPONS] &= ~( 1 << WP_GRAPPLING_HOOK );
				if ( cl->ps.weapon == WP_GRAPPLING_HOOK ) {
					for ( w = WP_NUM_WEAPONS - 1; w > WP_NONE; w-- ) {
						if ( w != WP_GRAPPLING_HOOK && ( cl->ps.stats[STAT_WEAPONS] & ( 1 << w ) ) ) {
							break;
						}
					}
					cl->ps.weapon = w;
					cl->ps.weaponstate = WEAPON_READY;
				}
			}
		}
		if ( quad != g_quadAll.integer ) {
			cl->ps.powerups[PW_QUAD] = g_quadAll.integer ? level.time + 0x7fffff : 0;
		}
	}
	grapple = g_grapple.integer;
	quad = g_quadAll.integer;
}

/*
==============================================================================

GUN GAME (g_weaponMode 4, free for all)

Everyone starts on the machinegun. A kill moves you to the next weapon in
gunGameWeapons; the score is your level, so g_fraglimit GUNGAME_LEVELS ends
the match when someone wins with a gauntlet kill on the last level. A
gauntlet kill knocks the victim down a level (it only moves the killer up on
the last level); a suicide or a death to the world costs a level too.

==============================================================================
*/

static const int gunGameWeapons[GUNGAME_LEVELS] = {
	WP_MACHINEGUN, WP_SHOTGUN, WP_LIGHTNING, WP_PLASMAGUN, WP_GRENADE_LAUNCHER,
	WP_ROCKET_LAUNCHER, WP_RAILGUN, WP_BFG, WP_GAUNTLET
};

int G_GunGameWeapon( int level ) {
	if ( level < 0 ) {
		level = 0;
	} else if ( level >= GUNGAME_LEVELS ) {
		level = GUNGAME_LEVELS - 1;
	}
	return gunGameWeapons[level];
}

static void G_GunGameSetLevel( gentity_t *ent, int lvl ) {
	gclient_t	*cl = ent->client;
	int			w;
	gitem_t		*item;

	if ( lvl < 0 ) {
		lvl = 0;
	} else if ( lvl > GUNGAME_LEVELS ) {
		lvl = GUNGAME_LEVELS;
	}
	if ( lvl == cl->ps.persistant[PERS_SCORE] ) {
		return;
	}
	cl->ps.persistant[PERS_SCORE] = lvl;
	CalculateRanks();
	if ( lvl >= GUNGAME_LEVELS ) {
		return;							// won: the fraglimit ends the match
	}

	// a living player swaps weapons now; a dead one gets it on respawn
	w = G_GunGameWeapon( lvl );
	if ( ent->health > 0 && cl->sess.sessionTeam != TEAM_SPECTATOR ) {
		cl->ps.stats[STAT_WEAPONS] = ( 1 << WP_GAUNTLET ) | ( 1 << w )
			| ( cl->ps.stats[STAT_WEAPONS] & ( 1 << WP_GRAPPLING_HOOK ) );
		if ( w != WP_GAUNTLET ) {
			cl->ps.ammo[w] = WEAPONMODE_AMMO;
		}
		cl->ps.weapon = w;
		cl->ps.weaponstate = WEAPON_READY;
		cl->ps.weaponTime = 0;
	}
	item = BG_FindItemForWeapon( w );
	trap_SendServerCommand( ent - g_entities, va( "cp \"^3level %i/%i\n^7%s\"",
		lvl + 1, GUNGAME_LEVELS, item ? item->pickup_name : "" ) );
	if ( lvl == GUNGAME_LEVELS - 1 ) {
		trap_SendServerCommand( -1, va( "print \"%s^7 is on the last level: ^1GAUNTLET^7!\n\"",
			cl->pers.netname ) );
	}
}

void G_GunGameKill( gentity_t *self, gentity_t *attacker, int meansOfDeath ) {
	int	lvl;

	if ( level.warmupTime || level.intermissionQueued || !self->client ) {
		return;
	}
	// suicide, falling, lava: down a level
	if ( !attacker || !attacker->client || attacker == self ) {
		G_GunGameSetLevel( self, self->client->ps.persistant[PERS_SCORE] - 1 );
		return;
	}
	if ( meansOfDeath == MOD_TELEFRAG ) {
		return;
	}
	lvl = attacker->client->ps.persistant[PERS_SCORE];
	if ( meansOfDeath == MOD_GAUNTLET ) {
		G_GunGameSetLevel( self, self->client->ps.persistant[PERS_SCORE] - 1 );
		if ( G_GunGameWeapon( lvl ) != WP_GAUNTLET ) {
			return;
		}
	}
	G_GunGameSetLevel( attacker, lvl + 1 );
}
