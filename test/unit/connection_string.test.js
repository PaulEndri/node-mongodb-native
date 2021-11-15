'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { promisify } = require('util');
const { MongoParseError, MongoDriverError, MongoInvalidArgumentError } = require('../../src/error');
const { loadSpecTests } = require('../spec');
const { parseOptions, resolveSRVRecord } = require('../../src/connection_string');
const { AuthMechanism } = require('../../src/cmap/auth/defaultAuthProviders');
const { expect } = require('chai');
const { Topology } = require('../../src/sdam/topology');
const { HostAddress } = require('../../src/utils');

// NOTE: These are cases we could never check for unless we write our own
//       url parser. The node parser simply won't let these through, so we
//       are safe skipping them.
const skipTests = [
  'Invalid port (negative number) with hostname',
  'Invalid port (non-numeric string) with hostname',
  'Missing delimiting slash between hosts and options',

  // These tests are only relevant to the native driver which
  // cares about specific keys, and validating their values
  'Unrecognized option keys are ignored',
  'Unsupported option values are ignored',

  // We don't actually support `wtimeoutMS` which this test depends upon
  'Deprecated (or unknown) options are ignored if replacement exists'
];

const SPEC_PATHS = ['load-balanced', 'replica-set', 'sharded'];

describe('Connection String', function () {
  it('should not support auth passed with user', function () {
    const optionsWithUser = {
      authMechanism: 'SCRAM-SHA-1',
      auth: { user: 'testing', password: 'llamas' }
    };

    expect(() => parseOptions('mongodb://localhost', optionsWithUser)).to.throw(MongoParseError);
  });

  it('should support auth passed with username', function () {
    const optionsWithUsername = {
      authMechanism: 'SCRAM-SHA-1',
      auth: { username: 'testing', password: 'llamas' }
    };
    const options = parseOptions('mongodb://localhost', optionsWithUsername);
    expect(options.credentials).to.containSubset({
      source: 'admin',
      username: 'testing',
      password: 'llamas'
    });
  });

  it('should provide a default port if one is not provided', function () {
    const options = parseOptions('mongodb://hostname');
    expect(options.hosts[0].socketPath).to.be.undefined;
    expect(options.hosts[0].host).to.be.a('string');
    expect(options.hosts[0].port).to.equal(27017);
  });

  it('should parse multiple readPreferenceTags', function () {
    const options = parseOptions(
      'mongodb://hostname?readPreferenceTags=bar:foo&readPreferenceTags=baz:bar'
    );
    expect(options.readPreference.tags).to.deep.equal([{ bar: 'foo' }, { baz: 'bar' }]);
  });

  it('should parse boolean values', function () {
    let options = parseOptions('mongodb://hostname?retryWrites=1');
    expect(options.retryWrites).to.equal(true);
    options = parseOptions('mongodb://hostname?retryWrites=false');
    expect(options.retryWrites).to.equal(false);
    options = parseOptions('mongodb://hostname?retryWrites=t');
    expect(options.retryWrites).to.equal(true);
  });

  it('should parse compression options', function () {
    const options = parseOptions('mongodb://localhost/?compressors=zlib&zlibCompressionLevel=4');
    expect(options).to.have.property('compressors');
    expect(options.compressors).to.include('zlib');
    expect(options.zlibCompressionLevel).to.equal(4);
  });

  it('should parse `readConcernLevel`', function () {
    const options = parseOptions('mongodb://localhost/?readConcernLevel=local');
    expect(options).to.have.property('readConcern');
    expect(options.readConcern.level).to.equal('local');
  });

  it('should parse `authMechanismProperties`', function () {
    const options = parseOptions(
      'mongodb://user%40EXAMPLE.COM:secret@localhost/?authMechanismProperties=SERVICE_NAME:other,SERVICE_REALM:blah,CANONICALIZE_HOST_NAME:true&authMechanism=GSSAPI'
    );
    expect(options.credentials.mechanismProperties).to.deep.include({
      SERVICE_NAME: 'other',
      SERVICE_REALM: 'blah',
      CANONICALIZE_HOST_NAME: true
    });
    expect(options.credentials.mechanism).to.equal(AuthMechanism.MONGODB_GSSAPI);
  });

  it('should parse a numeric authSource with variable width', function () {
    const options = parseOptions('mongodb://test@localhost/?authSource=0001');
    expect(options.credentials.source).to.equal('0001');
  });

  it('should parse a replicaSet with a leading number', function () {
    const options = parseOptions('mongodb://localhost/?replicaSet=123abc');
    expect(options).to.have.property('replicaSet');
    expect(options.replicaSet).to.equal('123abc');
  });

  describe('validation', function () {
    it('should validate compressors options', function () {
      expect(() => parseOptions('mongodb://localhost/?compressors=bunnies')).to.throw(
        MongoInvalidArgumentError,
        'bunnies is not a valid compression mechanism'
      );
    });

    it('should validate authMechanism', function () {
      expect(() => parseOptions('mongodb://localhost/?authMechanism=DOGS')).to.throw(
        MongoParseError,
        'authMechanism one of MONGODB-AWS,MONGODB-CR,DEFAULT,GSSAPI,PLAIN,SCRAM-SHA-1,SCRAM-SHA-256,MONGODB-X509, got DOGS'
      );
    });

    it('should validate readPreference', function () {
      expect(() => parseOptions('mongodb://localhost/?readPreference=llamasPreferred')).to.throw(
        MongoDriverError, // not parse Error b/c thrown from ReadPreference construction
        'Invalid read preference mode "llamasPreferred"'
      );
    });

    it('should validate non-equal tls values', function () {
      expect(() => parseOptions('mongodb://localhost/?tls=true&tls=false')).to.throw(
        MongoParseError,
        'All values of tls/ssl must be the same.'
      );
    });
  });

  describe('spec tests', function () {
    const suites = loadSpecTests('connection-string').concat(loadSpecTests('auth'));

    for (const suite of suites) {
      describe(suite.name, function () {
        for (const test of suite.tests) {
          it(`${test.description}`, function () {
            if (skipTests.includes(test.description)) {
              return this.skip();
            }

            const message = `"${test.uri}"`;

            const valid = test.valid;
            if (valid) {
              const options = parseOptions(test.uri);
              expect(options, message).to.be.ok;

              if (test.hosts) {
                for (const [index, { host, port }] of test.hosts.entries()) {
                  expect(options.hosts[index], message).to.satisfy(e => {
                    return e.host === host || e.socketPath === host;
                  });
                  if (typeof port === 'number') expect(options.hosts[index].port).to.equal(port);
                }
              }

              if (test.auth && test.auth.db != null) {
                expect(options.dbName, message).to.equal(test.auth.db);
              }

              if (test.auth && test.auth.username) {
                expect(options.credentials, message).to.exist;

                if (test.auth.db != null) {
                  expect(options.credentials.source, message).to.equal(test.auth.db);
                }

                if (test.auth.username != null) {
                  expect(options.credentials.username, message).to.equal(test.auth.username);
                }

                if (test.auth.password != null) {
                  expect(options.credentials.password, message).to.equal(test.auth.password);
                }
              }

              if (test.options) {
                for (const [optionKey, optionValue] of Object.entries(test.options)) {
                  switch (optionKey) {
                    case 'authmechanism':
                      expect(options.credentials.mechanism, message).to.eq(optionValue);
                      break;
                    case 'authmechanismproperties':
                      expect(options.credentials.mechanismProperties, message).to.deep.eq(
                        optionValue
                      );
                      break;
                    case 'replicaset':
                      expect(options.replicaSet, message).to.equal(optionValue);
                      break;
                    case 'w':
                      expect(options.writeConcern.w).to.equal(optionValue);
                      break;
                    default:
                      throw Error(`This options is not covered by the spec test: ${optionKey}`);
                  }
                }
              }
            } else {
              expect(() => parseOptions(test.uri), message).to.throw();
            }
          });
        }
      });
    }
  });

  describe('mongodb+srv', function () {
    it('should parse a default database', function () {
      const options = parseOptions('mongodb+srv://test1.test.build.10gen.cc/somedb');
      expect(options.dbName).to.equal('somedb');
      expect(options.srvHost).to.equal('test1.test.build.10gen.cc');
    });

    for (const folder of SPEC_PATHS) {
      describe(`spec tests ${folder}`, function () {
        const specPath = path.join(__dirname, '../spec', 'initial-dns-seedlist-discovery', folder);
        const testFiles = fs
          .readdirSync(specPath)
          .filter(x => x.indexOf('.json') !== -1)
          .map(x => [x, fs.readFileSync(path.join(specPath, x), 'utf8')])
          .map(x => [path.basename(x[0], '.json'), JSON.parse(x[1])]);

        for (const [fileName, test] of testFiles) {
          if (!test.comment) {
            test.comment = fileName;
          }

          const comment = test.comment;
          it(comment, {
            metadata: { requires: { topology: ['single'] } },
            async test() {
              let thrownError;
              let options;
              let hosts;
              try {
                options = parseOptions(test.uri);
                hosts = await promisify(resolveSRVRecord)(options);
              } catch (error) {
                thrownError = error;
              }

              if (test.error) {
                expect(thrownError).to.exist;
                expect(hosts).to.not.exist;
                return; // Nothing more to test...
              }

              expect(thrownError).to.not.exist;
              expect(options).to.exist;

              // Implicit SRV options must be set.
              expect(options.directConnection).to.be.false;
              const testOptions = test.options;
              if (testOptions && 'tls' in testOptions) {
                expect(options).to.have.property('tls', testOptions.tls);
              } else if (testOptions && 'ssl' in testOptions) {
                expect(options).to.have.property('tls', testOptions.ssl);
              } else {
                expect(options.tls).to.be.true;
              }
              if (testOptions && testOptions.replicaSet) {
                expect(options).to.have.property('replicaSet', testOptions.replicaSet);
              }
              if (testOptions && testOptions.authSource) {
                expect(options).to.have.property('credentials');
                expect(options.credentials.source).to.equal(testOptions.authSource);
              }
              if (testOptions && testOptions.loadBalanced) {
                expect(options).to.have.property('loadBalanced', testOptions.loadBalanced);
              }
              if (test.parsed_options && test.parsed_options.user && test.parsed_options.password) {
                expect(options.credentials.username).to.equal(test.parsed_options.user);
                expect(options.credentials.password).to.equal(test.parsed_options.password);
              }

              // srvMaxHost limiting happens in the topology constructor
              if (options.srvHost && comment.includes('srvMaxHosts')) {
                return this.skip(); // REMOVE ME!!!!
                // const topology = new Topology(hosts, options);
                // const initialSeedlist = hosts.map(h => h.toString());
                // const selectedHosts = Array.from(topology.s.description.servers.keys());

                // if (typeof test.numSeeds === 'number') {
                //   // numSeeds: the expected number of initial seeds discovered from the SRV record.
                //   expect(initialSeedlist).to.have.lengthOf(test.numSeeds);
                // }
                // if (typeof test.numHosts === 'number') {
                //   // numHosts: the expected number of hosts discovered once SDAM completes a scan.
                //   // (In our case, its the Topology constructor, but not actual SDAM)
                //   expect(selectedHosts).to.have.lengthOf(test.numHosts);
                // }

                // if (Array.isArray(test.seeds)) {
                //   // verify that the set of hosts in the client's initial seedlist
                //   // matches the list in seeds
                //   expect(initialSeedlist).to.deep.equal(test.seeds);
                // }
                // if (Array.isArray(test.hosts)) {
                //   // verify that the set of ServerDescriptions in the client's TopologyDescription
                //   // eventually matches the list in hosts
                //   const actualAddresses = await Promise.all(
                //     selectedHosts
                //       .map(async hn => await promisify(dns.lookup)(HostAddress.fromString(hn).host))
                //       .map(async (addr, i) => {
                //         let address = (await addr).address;
                //         address = address === '127.0.0.1' ? 'localhost' : address;
                //         return HostAddress.fromString(
                //           `${address}:${HostAddress.fromString(selectedHosts[i]).port}`
                //         ).toString();
                //       })
                //   );

                //   expect(actualAddresses).to.deep.equal(test.hosts);
                // }
              }
            }
          });
        }
      });
    }
  });
});
