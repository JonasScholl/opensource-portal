//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

import express = require('express');
import asyncHandler from 'express-async-handler';

import _ from 'lodash';
import { ReposAppRequest, IProviders } from '../../../transitional';
import { jsonError } from '../../../middleware/jsonError';
import { IndividualContext } from '../../../business/context2';
import { Organization } from '../../../business/organization';
import { CreateRepositoryCallback } from '../createRepo';
import { Team } from '../../../business/team';
import { GetAddressFromUpnAsync } from '../../../lib/mailAddressProvider';

const router = express.Router();

interface ILocalApiRequest extends ReposAppRequest {
  apiVersion?: string;
  organization?: Organization;
  knownRequesterMailAddress?: any;
}

router.get('/metadata', (req: ILocalApiRequest, res, next) => {
  try {
    const options = {
      projectType: req.query.projectType,
    };
    const organization = req.organization as Organization;
    const metadata = organization.getRepositoryCreateMetadata(options);
    res.json(metadata);
  } catch (error) {
    return next(jsonError(error, 400));
  }
});

router.get('/personalizedTeams', (req: ILocalApiRequest, res, next) => {
  const orgName = req.organization.name.toLowerCase();
  const operations = req.app.settings.providers.operations;
  const id = req.apiContext.getGitHubIdentity().id;
  const uc = operations.getUserContext(id);
  let maintainedTeams = new Set<string>(); // TODO: validaet whether number or string
  const broadTeams = new Set<number>(req.organization.broadAccessTeams);
  uc.getTeamMemberships('maintainer').then(mt => {
    mt.forEach(maintainedTeam => {
      maintainedTeams.add(maintainedTeam.id);
    });
    return uc.getTeamMemberships();
  }).then(teams => {
    _.remove(teams, (team: Team) => {
      // TODO: verify if it is name or login
      const oo = team.organization as any;
      const ooName = oo.login || oo.name;
      return ooName.toLowerCase() !== orgName; // return team.organization.login.toLowerCase() !== orgName;
    });
    // TODO: is this ok to modify this way!?!?!?!?
    teams.forEach(team => {
      delete team.organization;
      delete team.slug;
      team.role = maintainedTeams.has(team.id) ? 'maintainer' : 'member';
      if (broadTeams.has(team.id)) {
        team.broad = true;
      }
    });
    return res.json({
      personalizedTeams: teams,
    });
  }).catch(error => {
    return next(jsonError(error, 400));
  });
});

router.get('/teams', asyncHandler(async (req: ILocalApiRequest, res, next) => {
  // By default, allow a 30-second old list of teams. If the cached
  // view is older, refresh this list in the background for use if
  // they refresh for a better user experience.
  const caching = {
    backgroundRefresh: true,
    maxAgeSeconds: 30,
  };

  // If the user forces a true refresh, force a true walk of all the teams
  // from GitHub. This will be slow the larger the org. Allow a short cache
  // window for the casewhere a  webhook processes the change quickly.
  if (req.query.refresh) {
    caching.backgroundRefresh = false;
    caching.maxAgeSeconds = 10;
  }

  try {
    const teams = await req.organization.getTeams();
    const broadTeams = new Set(req.organization.broadAccessTeams);
    const simpleTeams = teams.map(team => {
      const t = team.toSimpleJsonObject();
      if (broadTeams.has(t.id)) {
        t['broad'] = true;
      }
      return t;
    });
    res.json({
      teams: simpleTeams,
    });
  } catch (getTeamsError) {
    return next(jsonError(getTeamsError, 400));
  }
}));

router.get('/repo/:repo', asyncHandler(async (req: ILocalApiRequest, res) => {
  const repoName = req.params.repo;
  let error = null;
  try {
    const repo = await req.organization.repository(repoName).getDetails();
    res.json(repo);
  } catch (repoDetailsError) {
    res.status(404).end();
    error = repoDetailsError;
  }
  req.app.settings.providers.insights.trackEvent({
    name: 'ApiClientNewRepoValidateAvailability',
    properties: {
      found: error ? true : false,
      repoName,
      org: req.organization.name,
    },
  });
}));

async function discoverUserIdentities(req: ReposAppRequest, res, next) {
  const apiContext = req.apiContext as IndividualContext;
  const providers = req.app.settings.providers as IProviders;
  const mailAddressProvider = providers.mailAddressProvider;
  // Try and also learn if we know their e-mail address to send the new repo mail to
  const upn = apiContext.corporateIdentity.username;
  try {
    const mailAddress = await GetAddressFromUpnAsync(mailAddressProvider, upn);
    if (mailAddress) {
      req['knownRequesterMailAddress'] = mailAddress;
    }
  } catch (ignoredError) { /* ignored */ }
  return next();
}

router.post('/repo/:repo', asyncHandler(discoverUserIdentities), (req: ILocalApiRequest, res, next) => {
  const config = req.app.settings.runtimeConfig;
  const body = req.body;
  if (!body) {
    return next(jsonError('No body', 400));
  }
  req.apiVersion = req.query['api-version'] || req.headers['api-version'] || '2017-07-27';

  if (req.apiContext && req.apiContext.getGitHubIdentity()) {
    body['ms.onBehalfOf'] = req.apiContext.getGitHubIdentity().username;
  }

  // these fields do not need translation: name, description, private
  const approvalTypesToIds = config.github.approvalTypes.fields.approvalTypesToIds;
  if (!approvalTypesToIds[body.approvalType]) {
    return next(jsonError('The approval type is not supported or approved at this time', 400));
  }
  body.approvalType = approvalTypesToIds[body.approvalType];
  translateValue(body, 'approvalType', 'ms.approval');
  translateValue(body, 'approvalUrl', 'ms.approval-url');
  translateValue(body, 'justification', 'ms.justification');
  translateValue(body, 'legalEntity', 'ms.cla-entity');
  translateValue(body, 'claMails', 'ms.cla-mail');
  translateValue(body, 'projectType', 'ms.project-type');

  // Team permissions
  if (!body.selectedAdminTeams || !body.selectedAdminTeams.length) {
    return next(jsonError('No administration team(s) provided in the request', 400));
  }
  translateTeams(body);

  // Initial repo contents and license
  const templates = _.keyBy(req.organization.getRepositoryCreateMetadata().templates, 'id');
  const template = templates[body.template];
  if (!template) {
    return next(jsonError('There was a configuration problem, the template metadata was not available for this request', 400));
  }
  translateValue(body, 'template', 'ms.template');
  body['ms.license'] = template.spdx || template.name; // Today this is the "template name" or SPDX if available
  translateValue(body, 'gitIgnoreTemplate', 'gitignore_template');

  if (!body['ms.notify']) {
    body['ms.notify'] = req.knownRequesterMailAddress || config.brand.operationsMail || config.brand.supportMail;
  }

  // these fields are currently ignored: orgName
  delete body.orgName;
  delete body.claEntity;

  const token = req.organization.getRepositoryCreateGitHubToken();
  req.app.settings.providers.insights.trackEvent({
    name: 'ApiClientNewOrgRepoStart',
    properties: {
      body: JSON.stringify(req.body),
    },
  });
  CreateRepositoryCallback(req, res, body, token, (error, success) => {
    if (error) {
      if (!error.json) {
        error = jsonError(error, 400);
      }
      return next(error);
    }

    success.title = 'Repository created';
    success.message = success.github ?
      `Your new repo, ${success.github.name}, has been created:` :
      'Your repo request has been submitted.';

    // url
    if (success.github) {
      success.url = success.github.html_url;
    }

    // rename tasks to messages
    success.messages = success.tasks;
    delete success.tasks;

    res.json(success);
  });
});

function translateTeams(body) {
  let admin = body.selectedAdminTeams;
  let write = body.selectedWriteTeams;
  let read = body.selectedReadTeams;

  // Remove teams with higher privileges already
  _.pullAll(write, admin);
  _.pullAll(read, admin);
  _.pullAll(read, write);

  body['ms.teams'] = {
    admin: admin,
    push: write,
    pull: read,
  };

  delete body.selectedAdminTeams;
  delete body.selectedWriteTeams;
  delete body.selectedReadTeams;
}

function translateValue(object, fromKey, toKey) {
  if (object[fromKey]) {
    object[toKey] = object[fromKey];
  }
  if (object[fromKey] !== undefined) {
    delete object[fromKey];
  }
}

module.exports = router;
