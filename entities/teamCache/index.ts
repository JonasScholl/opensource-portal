//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

import { ITeamCacheProvider, ITeamCacheCreateOptions, TeamCacheProvider } from './teamCacheProvider';
import { FixedQueryType, IEntityMetadataFixedQuery } from '../../lib/entityMetadataProvider/query';

export async function CreateTeamCacheProviderInstance(options?: ITeamCacheCreateOptions): Promise<ITeamCacheProvider> {
  const provider = new TeamCacheProvider(options);
  await provider.initialize();
  return provider;
}

export class TeamCacheFixedQueryAll implements IEntityMetadataFixedQuery {
  public readonly fixedQueryType: FixedQueryType = FixedQueryType.TeamCacheGetAll;
}

export class TeamCacheFixedQueryByOrganizationId implements IEntityMetadataFixedQuery {
  public readonly fixedQueryType: FixedQueryType = FixedQueryType.TeamCacheGetByOrganizationId;
  constructor(public organizationId: string) {
    if (typeof(this.organizationId) !== 'string') {
      throw new Error(`${organizationId} must be a string`);
    }
  }
}
