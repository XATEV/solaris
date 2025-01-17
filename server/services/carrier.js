const mongoose = require('mongoose');
const ValidationError = require('../errors/validation');

module.exports = class CarrierService {

    constructor(achievementService, distanceService, starService, technologyService, specialistService) {
        this.achievementService = achievementService;
        this.distanceService = distanceService;
        this.starService = starService;
        this.technologyService = technologyService;
        this.specialistService = specialistService;
    }

    getById(game, id) {
        return game.galaxy.carriers.find(s => s._id.toString() === id);
    }

    getByObjectId(game, id) {
        return game.galaxy.carriers.find(s => s._id.equals(id));
    }

    getCarriersAtStar(game, starId) {
      return game.galaxy.carriers.filter(carrier => carrier.orbiting && carrier.orbiting.toString() === starId.toString())
    }

    createAtStar(star, carriers, ships = 1) {
        if (!Math.floor(star.garrisonActual)) {
            throw new ValidationError('Star must have a garrison to build a carrier.');
        }

        // Generate a name for the new carrier based on the star name but make sure
        // this name isn't already taken by another carrier.
        let name = this.generateCarrierName(star, carriers);

        let carrier = {
            _id: mongoose.Types.ObjectId(),
            ownedByPlayerId: star.ownedByPlayerId,
            ships: ships,
            orbiting: star._id,
            location: star.location,
            name,
            waypoints: [],
            waypointsLooped: false
        };

        // Reduce the star garrison by how many we have added to the carrier.
        star.garrisonActual -= ships;
        star.garrison -= ships;

        return carrier;
    }

    listCarriersOwnedByPlayer(carriers, playerId) {
        return carriers.filter(s => s.ownedByPlayerId && s.ownedByPlayerId.equals(playerId));
    }

    generateCarrierName(star, carriers) {
        let i = 1;
        let name = `${star.name} ${i++}`;
        
        while (carriers.find(c => c.name == name)) {
            name = `${star.name} ${i++}`;
        }

        return name;
    }

    getCarriersWithinScanningRangeOfStar(game, star) {
        if (star.ownedByPlayerId == null) {
            return [];
        }

        let effectiveTechs = this.technologyService.getStarEffectiveTechnologyLevels(game, star);
        let scanningRangeDistance = this.distanceService.getScanningDistance(game, effectiveTechs.scanning);

        // Go through all stars and find each star that is in scanning range.
        let carriersInRange = game.galaxy.carriers.filter(c => {
            return c.ownedByPlayerId.equals(star.ownedByPlayerId) ||
                this.distanceService.getDistanceBetweenLocations(c.location, star.location) <= scanningRangeDistance;
        });

        return carriersInRange;
    }

    filterCarriersByScanningRange(game, player) {
        // Stars may have different scanning ranges independently so we need to check
        // each star to check what is within its scanning range.
        let playerStars = this.starService.listStarsOwnedByPlayer(game.galaxy.stars, player._id);
        let inRange = [];

        for (let star of playerStars) {
            let carriers = this.getCarriersWithinScanningRangeOfStar(game, star);

            for (let c of carriers) {
                if (inRange.indexOf(c) === -1) {
                    inRange.push(c);
                }
            }
        }

        return inRange;
    }

    sanitizeCarriersByPlayer(game, player) {
        // Filter all waypoints (except those in transit) for all carriers that do not belong
        // to the player.
        return game.galaxy.carriers
        .map(c => {
            if (c.ownedByPlayerId.equals(player._id)) {
                return c;
            }

            // Return only key data about the carrier and the waypoints
            // if the carrier does not belong to the given player.
            let carrierData = {
                _id: c._id,
                ownedByPlayerId: c.ownedByPlayerId,
                orbiting: c.orbiting,
                inTransitFrom: c.inTransitFrom,
                inTransitTo: c.inTransitTo,
                name: c.name,
                ships: c.ships,
                location: c.location,
                waypoints: c.waypoints,
                isGift: c.isGift,
                specialistId: c.specialistId,
                specialist: null
            };

            carrierData.waypoints = this.clearCarrierWaypointsNonTransit(c, true);

            return carrierData;
        });
    }

    clearCarrierWaypointsNonTransit(carrier, obfuscateFirstWaypoint = false) {
        let waypoints = [];

        if (!carrier.orbiting) {
            waypoints = carrier.waypoints.slice(0, 1);

            if (obfuscateFirstWaypoint) {
                // Hide any sensitive info about the waypoint.
                let wp = waypoints[0];

                wp.action = 'collectAll';
                wp.actionShips = 0;
                wp.delayTicks = 0;
            }
        }

        return waypoints;
    }
    
    clearPlayerCarrierWaypointsNonTransit(game, player) {
        let carriers = this.listCarriersOwnedByPlayer(game.galaxy.carriers, player._id);

        for (let carrier of carriers) {
            carrier.waypoints = this.clearCarrierWaypointsNonTransit(carrier);
        }
    }

    clearPlayerCarriers(game, player) {
        game.galaxy.carriers = game.galaxy.carriers.filter(c => !c.ownedByPlayerId
            || !c.ownedByPlayerId.equals(player._id));
    }

    getCarrierDistancePerTick(game, carrier, warpSpeed = false) {
        let distanceModifier = warpSpeed ? game.constants.distances.warpSpeedMultiplier : 1;

        if (carrier.specialistId) {
            let specialist = this.specialistService.getByIdCarrier(carrier.specialistId);

            if (specialist.modifiers.local) {
                distanceModifier *= (specialist.modifiers.local.speed || 1);
            }
        }

        return game.constants.distances.shipSpeed * distanceModifier;
    }

    async convertToGift(game, player, carrierId) {
        let carrier = this.getById(game, carrierId);

        if (game.settings.specialGalaxy.giftCarriers === 'disabled') {
            throw new ValidationError(`Gifting carriers has been disabled in this game.`);
        }

        if (!carrier.ownedByPlayerId.equals(player._id)) {
            throw new ValidationError(`Cannot convert carrier into a gift, you do not own this carrier.`);
        }

        if (carrier.orbiting) {
            throw new ValidationError(`The carrier must be in transit in order to be converted into a gift.`);
        }

        if (carrier.isGift) {
            throw new ValidationError(`The carrier has already been converted into a gift.`);
        }

        // Convert the carrier into a gift.
        // Remove all waypoints except from the first waypoint
        // Set its waypoint action to be "do nothing"
        carrier.isGift = true;
        carrier.waypointsLooped = false;

        let firstWaypoint = carrier.waypoints[0];

        firstWaypoint.action = 'nothing';
        firstWaypoint.actionShips = 0;
        firstWaypoint.delayTicks = 0;

        carrier.waypoints = [firstWaypoint];
        
        await game.save();

        await this.achievementService.incrementGiftsSent(player.userId, carrier.ships);
    }

    async transferGift(game, star, carrier) {
        if (!star.ownedByPlayerId) {
            throw new ValidationError(`Cannot transfer ownership of a gifted carrier to this star, no player owns the star.`);
        }

        carrier.ownedByPlayerId = star.ownedByPlayerId;
        carrier.isGift = false;

        let player = game.galaxy.players.find(p => p._id.equals(star.ownedByPlayerId));

        await this.achievementService.incrementGiftsReceived(player.userId, carrier.ships);
    }

    canPlayerSeeCarrierShips(player, carrier) {
        if (carrier.specialistId) {
            let specialist = this.specialistService.getByIdCarrier(carrier.specialistId);

            // If the carrier has a hideCarrierShips spec and is not owned by the given player
            // then that player cannot see the carrier's ships.
            if (specialist.modifiers.special && specialist.modifiers.special.hideCarrierShips
                && carrier.ownedByPlayerId.toString() !== player._id.toString()) {
                return false;
            }
        }

        return true;
    }

    moveCarrierToCurrentWaypoint(carrier, destinationStar, distancePerTick) {
        let nextLocation = this.distanceService.getNextLocationTowardsLocation(carrier.location, destinationStar.location, distancePerTick);

        carrier.location = nextLocation;
    }

    async arriveAtStar(game, carrier, destinationStar) {
        // Remove the current waypoint as we have arrived at the destination.
        let currentWaypoint = carrier.waypoints.splice(0, 1)[0];

        let report = {
            waypoint: currentWaypoint,
            combatRequiredStar: false
        };

        carrier.inTransitFrom = null;
        carrier.inTransitTo = null;
        carrier.orbiting = destinationStar._id;
        carrier.location = destinationStar.location;

        // If the carrier waypoints are looped then append the
        // carrier waypoint back onto the waypoint stack.
        if (carrier.waypointsLooped) {
            carrier.waypoints.push(currentWaypoint);
        }

        // If the star is unclaimed, then claim it.
        if (destinationStar.ownedByPlayerId == null) {
            await this.starService.claimUnownedStar(game, destinationStar, carrier);
        }

        // If the star is owned by another player, then perform combat.
        if (!destinationStar.ownedByPlayerId.equals(carrier.ownedByPlayerId)) {
            // If the carrier is a gift, then transfer the carrier ownership to the star owning player.
            // Otherwise, perform combat.
            if (carrier.isGift) {
                await this.transferGift(game, destinationStar, carrier);
            } else {
                report.combatRequiredStar = true;
            }
        }

        return report;
    }

    async moveCarrier(game, carrier) {
        let waypoint = carrier.waypoints[0];
        let sourceStar = game.galaxy.stars.find(s => s._id.equals(waypoint.source));
        let destinationStar = game.galaxy.stars.find(s => s._id.equals(waypoint.destination));
        let carrierOwner = game.galaxy.players.find(p => p._id.equals(carrier.ownedByPlayerId));
        let warpSpeed = this.starService.canTravelAtWarpSpeed(carrierOwner, carrier, sourceStar, destinationStar);
        let distancePerTick = this.getCarrierDistancePerTick(game, carrier, warpSpeed);

        let carrierMovementReport = {
            carrier,
            sourceStar,
            destinationStar,
            carrierOwner,
            warpSpeed,
            distancePerTick,
            waypoint,
            combatRequiredStar: false,
            arrivedAtStar: false
        };
        
        if (carrier.distanceToDestination <= distancePerTick) {
            let starArrivalReport = await this.arriveAtStar(game, carrier, destinationStar);
            
            carrierMovementReport.waypoint = starArrivalReport.waypoint;
            carrierMovementReport.combatRequiredStar = starArrivalReport.combatRequiredStar;
            carrierMovementReport.arrivedAtStar = true;
        }
        // Otherwise, move X distance in the direction of the star.
        else {
            this.moveCarrierToCurrentWaypoint(carrier, destinationStar, distancePerTick);
        }

        return carrierMovementReport;
    }

    getNextLocationToWaypoint(game, carrier) {
        let waypoint = carrier.waypoints[0];
        let sourceStar = game.galaxy.stars.find(s => s._id.equals(waypoint.source));
        let destinationStar = game.galaxy.stars.find(s => s._id.equals(waypoint.destination));
        let carrierOwner = game.galaxy.players.find(p => p._id.equals(carrier.ownedByPlayerId));
        let warpSpeed = this.starService.canTravelAtWarpSpeed(carrierOwner, carrier, sourceStar, destinationStar);
        let distancePerTick = this.getCarrierDistancePerTick(game, carrier, warpSpeed);

        let nextLocation = this.distanceService.getNextLocationTowardsLocation(carrier.location, destinationStar.location, distancePerTick);

        return nextLocation;
    }

    isInTransit(carrier) {
        return !carrier.orbiting;
    }

    isLaunching(carrier) {
        return carrier.orbiting && carrier.waypoints.length && carrier.waypoints[0].delayTicks === 0;
    }
    
};
