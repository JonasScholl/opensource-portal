//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["warn", "dir", "log"] }] */

'use strict';

import async = require('async');
import { Repository } from '../../business/repository';
import { Operations } from '../../business/operations';
import { TeamPermission } from '../../business/teamPermission';
const os = require('os');

const automaticTeams = require('../../webhooks/tasks/automaticTeams');

// Permissions processing: visit all repos and make sure that any designated read, write, admin
// teams for the organization are present on every repo. This job is designed to be run relatively
// regularly but is not looking to answer "the truth" - it will use the cache of repos and other
// assets to not abuse GitHub and its API exhaustively. Over time repos will converge to having
// the right permissions.

const maxParallelism = 2;

module.exports = function run(started, startedString, config) {
  console.log(`Job started ${startedString}`);

  const app = require('../../app');
  config.skipModules = new Set([
    'web',
  ]);

  app.initializeJob(config, null, error => {
    if (error) {
      throw error;
    }
    const insights = app.settings.appInsightsClient;
    if (!insights) {
      throw new Error('No app insights client available');
    }
    insights.trackEvent({
      name: 'JobPermissionsStarted',
      properties: {
        hostname: os.hostname(),
      },
    });
    permissionsRun(config, app).then(done => {
      console.log('done');
      process.exit(0);
    }).catch(error => {
      if (insights) {
        insights.trackException({ exception: error, properties: { name: 'JobPermissionsFailure' } });
      }
      throw error;
    });
  });
};

async function permissionsRun(config, app) : Promise<void> {
  const operations = app.settings.operations as Operations;
  const repos = await operations.getRepos();
  console.log(`We have a lot of repos: ${repos.length}`);
  let z = 0;
  for (let repo of repos) {
    const cacheOptions = {
      maxAgeSeconds: 10 * 60 /* 10m */,
      backgroundRefresh: false,
    };
    ++z;
    if (z % 250 === 1) {
      console.log('. ' + z);
    }
    const destructured = automaticTeams.processOrgSpecialTeams(repo.organization); // const [/*specialTeams*/, /*specials*/, specialTeamIds, specialTeamLevels] = automaticTeams.processOrgSpecialTeams(repo.organization);
    const specialTeamIds = destructured[2];
    const specialTeamLevels = destructured[3];
    let permissions: TeamPermission[] = null;
    try {
      permissions = await repo.getTeamPermissions(cacheOptions);
    } catch (getError) {
      if (getError.status == /* loose */ 404) {
        console.log(`Repo gone: ${repo.organization.name}/${repo.name}`);
      } else {
        console.log(`There was a problem getting the permissions for the repo ${repo.name} from ${repo.organization.name}`);
        console.dir(getError);
      }
      return;
    }
    const currentPermissions = new Map<string, TeamPermission>();
    permissions.forEach(entry => {
      currentPermissions.set(entry.team.id, entry.permission);
    });
    const teamsToSet = new Set<string>();
    specialTeamIds.forEach(specialTeamId => {
      if (!currentPermissions.has(specialTeamId)) {
        teamsToSet.add(specialTeamId);
      } else if (isAtLeastPermissionLevel(currentPermissions.get(specialTeamId), specialTeamLevels.get(specialTeamId))) {
        // The team permission is already acceptable
      } else {
        console.log(`Permission level for ${specialTeamId} is not good enough, expected ${specialTeamLevels.get(specialTeamId)} but currently ${currentPermissions.get(specialTeamId)}`);
        teamsToSet.add(specialTeamId);
      }
    });
    const setArray = Array.from(teamsToSet.values());
    for (let teamId of setArray) {
      const newPermission = specialTeamLevels.get(teamId);
      console.log(`adding ${teamId} team with permission ${newPermission} to the repo ${repo.name}`);
      try {
        await repo.setTeamPermission(teamId, newPermission);
      } catch (error) {
        console.log(`${repo.name}`);
        console.dir(error);
      }
    }
  }
}

function isAtLeastPermissionLevel(value, expected) {
  if (value !== 'admin' && value !== 'push' && value !== 'pull') {
    throw new Error(`The permission type ${value} is not understood by isAtLeastPermissionLevel`);
  }
  if (value === expected) {
    return true;
  }
  // Admin always wins
  if (value === 'admin') {
    return true;
  } else if (expected === 'admin') {
    return false;
  }
  if (expected === 'write' && value === expected) {
    return true;
  }
  if (expected === 'read') {
    return true;
  }
  return false;
}
