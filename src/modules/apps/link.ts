import { Builder, Change } from '@vtex/api'
import axios from 'axios'
import chalk from 'chalk'
import { execSync } from 'child-process-es6-promise'
import * as chokidar from 'chokidar'
import * as debounce from 'debounce'
import { readFileSync } from 'fs'
import { outputJson, pathExists, readJson } from 'fs-extra'
import * as moment from 'moment'
import { join, resolve as resolvePath, sep} from 'path'
import { concat, equals, filter, has, isEmpty, isNil, map, mapObjIndexed, merge, path as ramdaPath, pipe, prop, reject as ramdaReject, test, toPairs, values } from 'ramda'
import { createInterface } from 'readline'
import { createClients } from '../../clients'
import { getAccount, getEnvironment, getWorkspace } from '../../conf'
import { CommandError } from '../../errors'
import { getMostAvailableHost } from '../../host'
import { toAppLocator } from '../../locator'
import log from '../../logger'
import { getManifest } from '../../manifest'
import { listenBuild } from '../build'
import { formatNano } from '../utils'
import startDebuggerTunnel from './debugger'
import { createLinkConfig, getIgnoredPaths, getLinkedDepsDirs, getLinkedFiles, listLocalFiles } from './file'
import legacyLink from './legacyLink'
import lint from './lint'
import { checkBuilderHubMessage, isLinked, pathToFileObject, resolveAppId, showBuilderHubMessage, validateAppAction } from './utils'

const root = process.cwd()
const DELETE_SIGN = chalk.red('D')
const UPDATE_SIGN = chalk.blue('U')
const stabilityThreshold = process.platform === 'darwin' ? 100 : 200
const AVAILABILITY_TIMEOUT = 1000
const N_HOSTS = 3
const builderHubInjectedDepsTimeout = 2000  // 2 seconds

const resolvePackageJsonPath = (builder: string) => resolvePath(process.cwd(), `${builder}/package.json`)


const typingsInfo = async (workspace: string, account: string, environment: string) => {
  const extension = (environment === 'prod') ? 'myvtex' : 'myvtexdev'
  const http = axios.create({
    baseURL: `https://${workspace}--${account}.${extension}.com`,
    timeout: builderHubInjectedDepsTimeout,
  })
  try {
    const res = await http.get(`/_v/private/builder/0/typings`)
    return res.data.typingsInfo
  } catch (e) {
    log.error('Unable to get typings info from vtex.builder-hub.')
    return {}
  }
}

const appTypingsURL = async (account: string, workspace: string, environment: string, appName: string, appVersion: string, builder: string): Promise<string> => {
  const extension = (environment === 'prod') ? 'myvtex' : 'myvtexdev'
  const appId = await resolveAppId(appName, appVersion)
  const typingsPath = isLinked({'version': appId}) ? 'linked/v1' : 'v1'
  return `https://${workspace}--${account}.${extension}.com/_v/private/typings/${typingsPath}/${appId}/${builder}`
}

const appsWithTypingsURLs = async (builder: string, account: string, workspace: string, environment: string, appDependencies: Record<string, any>) => {
  const result: Record<string, any> = {}
  for (const [appName, appVersion] of Object.entries(appDependencies)) {
    result[appName] = await appTypingsURL(account, workspace, environment, appName, appVersion, builder)
  }
  return result
}

const runYarn = (relativePath: string) => {
  log.info(`Running yarn in ${relativePath}`)
  execSync(
    join(__dirname, '../../../node_modules/yarn/bin/yarn.js --force'),
    {stdio: 'inherit', cwd: `./${relativePath}`}
  )
  log.info('Finished running yarn')
}

const getTypings = async (manifest: Manifest, account: string, workspace: string, environment: string) => {
  const typingsData = await typingsInfo(workspace, account, environment)

  const buildersWithInjectedDeps =
    pipe(
      prop('builders'),
      mapObjIndexed(
        (version: string, builder: string) => {
          const builderTypingsData = prop(builder, typingsData)
          if (builderTypingsData && has(version, builderTypingsData)) {
            return ramdaPath([version, 'injectedDependencies'], builderTypingsData)
          }
          return null
        }
      ),
      ramdaReject(isNil)
    )(manifest)

  const buildersWithAppDeps =
    pipe(
      mapObjIndexed(
        (injectedDependencies) => merge(manifest.dependencies, injectedDependencies)
      ),
      ramdaReject(isEmpty)
    )(buildersWithInjectedDeps as Record<string, any>)

  const buildersToRunYarn = ramdaReject(isNil,
    await pipe(
      mapObjIndexed(
        // If Yarn should be run in a builder, the following entry will be
        // present in the object: {`builder`: `builder`}.
        // If not, this entry will be in the object: {`builder`: null}. These
        // entries will then be rejected.
        async (appDeps: Record<string, any>, builder: string) => {
          const packageJsonPath = resolvePackageJsonPath(builder)
          if (await pathExists(packageJsonPath)) {
            const packageJson = await readJson(packageJsonPath)
            const oldDevDeps = packageJson.devDependencies || {}
            const oldTypingsEntries = filter(test(/_v\/private\/typings/), oldDevDeps)
            const newTypingsEntries = await appsWithTypingsURLs(builder, account, workspace, environment, appDeps)
            if (!equals(oldTypingsEntries, newTypingsEntries)) {
              const cleanOldDevDeps = ramdaReject(test(/_v\/private\/typings/), oldDevDeps)
              await outputJson(
                packageJsonPath,
                {
                  ...packageJson,
                  ...{ 'devDependencies': { ...cleanOldDevDeps, ...newTypingsEntries } },
                },
                { spaces: '\t' }
              )
              return builder
            }
          }
          return null
        }
      ),
      values,
      Promise.all
    )(buildersWithAppDeps as Record<string, any>)
  )

  map(runYarn)(buildersToRunYarn)
}

const warnAndLinkFromStart = (appId: string, builder: Builder, extraData: { linkConfig: LinkConfig } = { linkConfig: null }) => {
  log.warn('Initial link requested by builder')
  performInitialLink(appId, builder, extraData)
  return null
}

const watchAndSendChanges = async (appId: string, builder: Builder, extraData : {linkConfig : LinkConfig}): Promise<any> => {
  const changeQueue: Change[] = []

  const onInitialLinkRequired = e => {
    const data = e.response && e.response.data
    if (data && data.code && data.code === 'initial_link_required') {
      return warnAndLinkFromStart(appId, builder, extraData)
    }
    throw e
  }

  const defaultPatterns = ['*/**', 'manifest.json', 'policies.json']
  const linkedDepsPatterns = map(path => join(path, '**'), getLinkedDepsDirs(extraData.linkConfig))

  const queueChange = (path: string, remove?: boolean) => {
    console.log(`${chalk.gray(moment().format('HH:mm:ss:SSS'))} - ${remove ? DELETE_SIGN : UPDATE_SIGN} ${path}`)
    changeQueue.push(pathToChange(path, remove))
    sendChanges()
  }

  const sendChanges = debounce(() => {
    builder.relinkApp(appId, changeQueue.splice(0, changeQueue.length))
      .catch(onInitialLinkRequired)
  }, 300)

  const pathToChange = (path: string, remove?: boolean): Change => ({
    content: remove ? null : readFileSync(resolvePath(root, path)).toString('base64'), path : pathModifier(path),
  })

  const moduleAndMetadata = toPairs(extraData.linkConfig.metadata)

  const mapLocalToBuiderPath = path => {
    const abs = resolvePath(path)
    for (const [module, modulePath] of moduleAndMetadata) {
      if (abs.startsWith(modulePath)) {
        return abs.replace(modulePath, join('.linked_deps', module))
      }
    }
    return path
  }

  const pathModifier = pipe(
    mapLocalToBuiderPath,
    path => path.split(sep).join('/'))

  const addIgnoreNodeModulesRule =
    (paths: Array<string | ((path: string) => boolean)>) =>
      paths.concat((path: string) => path.includes('node_modules'))

  const watcher = chokidar.watch([...defaultPatterns, ...linkedDepsPatterns], {
    atomic: stabilityThreshold,
    awaitWriteFinish: {
      stabilityThreshold,
    },
    cwd: root,
    ignoreInitial: true,
    ignored: addIgnoreNodeModulesRule(getIgnoredPaths(root)),
    persistent: true,
    usePolling: process.platform === 'win32',
  })

  return new Promise((resolve, reject) => {
    watcher
      .on('add', (file, { size }) => size > 0 ? queueChange(file) : null)
      .on('change', (file, { size }) => {
        return size > 0
          ? queueChange(file)
          : queueChange(file, true)
      })
      .on('unlink', file => queueChange(file, true))
      .on('error', reject)
      .on('ready', resolve)
  })
}

const performInitialLink = async (appId: string, builder: Builder, extraData : {linkConfig : LinkConfig}): Promise<void> => {
  const [linkConfig , stickyHint] = await Promise.all([
    createLinkConfig(root),
    getMostAvailableHost(appId, builder, N_HOSTS, AVAILABILITY_TIMEOUT),
  ])

  const linkOptions = { sticky: true, stickyHint }

  extraData.linkConfig = linkConfig

  const usedDeps = toPairs(linkConfig.metadata)
  if (usedDeps.length) {
    const plural = usedDeps.length > 1
    log.info(`The following local dependenc${plural ? 'ies are' : 'y is'} linked to your app:`)
    usedDeps.forEach(([dep, path]) => log.info(`${dep} (from: ${path})`))
    log.info(`If you don\'t want ${plural ? 'them' : 'it'} to be used by your vtex app, please unlink ${plural ? 'them' : 'it'}`)
  }

  const [localFiles, linkedFiles] =
    await Promise.all([
      listLocalFiles(root).then(paths => map(pathToFileObject(root), paths)),
      getLinkedFiles(linkConfig),
    ])
  const filesWithContent = concat(localFiles, linkedFiles) as BatchStream[]

  const linkedFilesInfo = linkedFiles.length ? `(${linkedFiles.length} from linked node modules)` : ''
  log.info(`Sending ${filesWithContent.length} file${filesWithContent.length > 1 ? 's' : ''} ${linkedFilesInfo}`)
  log.debug('Sending files')
  filesWithContent.forEach(p => log.debug(p.path))

  try {
    const { code } = await builder.linkApp(appId, filesWithContent, linkOptions)
    if (code !== 'build.accepted') {
      throw new Error('Please, update your builder-hub to the latest version!')
    }
  } catch (e) {
    const data = e.response && e.response.data
    if (data && data.code && data.code === 'build_in_progress') {
      log.warn(`Build for ${appId} is already in progress`)
    } else {
      throw e
    }
  }
}

export default async (options) => {
  await validateAppAction('link')
  const manifest = await getManifest()
  const builderHubMessage = await checkBuilderHubMessage('link')
  if (!isEmpty(builderHubMessage)) {
    await showBuilderHubMessage(builderHubMessage.message, builderHubMessage.prompt, manifest)
  }

  if (manifest.builders.render
    || manifest.builders['functions-ts']
    || manifest.name === 'builder-hub') {
    return legacyLink(options)
  }

  try {
    await lint(root)
  } catch (e) {
    log.error('Failed to copy eslint setup')
  }

  const appId = toAppLocator(manifest)
  const context = { account: getAccount(), workspace: getWorkspace(), environment: getEnvironment() }
  if (options.install || options.i) {
    await getTypings(manifest, context.account, context.workspace, context.environment)
  }
  const { builder } = createClients(context, { timeout: 60000 })

  if (options.c || options.clean) {
    log.info('Requesting to clean cache in builder.')
    const { timeNano } = await builder.clean(appId)
    log.info(`Cache cleaned successfully in ${formatNano(timeNano)}`)
  }

  const onError = {
    build_failed: () => { log.error(`App build failed. Waiting for changes...`) },
    initial_link_required: () => warnAndLinkFromStart(appId, builder),
  }

  let debuggerStarted = false
  const onBuild = async () => {
    if (debuggerStarted) {
      return
    }
    debuggerStarted = true
    const debuggerPort = await startDebuggerTunnel(manifest)
    if (debuggerPort) {
      log.info(`Debugger tunnel listening on ${chalk.green(`:${debuggerPort}`)}. Go to ${chalk.blue('chrome://inspect')} in Google Chrome to debug your running application.`)
    }
  }

  log.info(`Linking app ${appId}`)

  let unlistenBuild
  const extraData = { linkConfig: null }
  try {
    const buildTrigger = performInitialLink.bind(this, appId, builder, extraData)
    const [subject] = appId.split('@')
    const { unlisten } = await listenBuild(subject, buildTrigger, { waitCompletion: false, onBuild, onError })
    unlistenBuild = unlisten
  } catch (e) {
    if (e.response) {
      const { data } = e.response
      if (data.code === 'routing_error' && /app_not_found.*vtex\.builder\-hub/.test(data.message)) {
        return log.error('Please install vtex.builder-hub in your account to enable app linking (vtex install vtex.builder-hub)')
      }

      if (data.code === 'link_on_production') {
        throw new CommandError(`Please remove your workspace from production (${chalk.blue('vtex workspace production false')}) to enable app linking`)
      }
    }
    throw e
  }

  createInterface({ input: process.stdin, output: process.stdout })
    .on('SIGINT', () => {
      if (unlistenBuild) {
        unlistenBuild()
      }
      log.info('Your app is still in development mode.')
      log.info(`You can unlink it with: 'vtex unlink ${appId}'`)
      process.exit()
    })

  await watchAndSendChanges(appId, builder, extraData)
}
