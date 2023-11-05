// ==UserScript==
// @name         PR Analyser
// @version      1.0
// @description  Analyses PR changes and adds tasks
// @match        https://{server}/projects/*/repos/*/pull-requests/*/overview
// ==/UserScript==

const VERSION = "1.0"; // Ensure this matches the metadata at the top.

const getPRMetadata = () => {
    var pathParts = window.location.pathname.split('/');

    return {
        'project': pathParts[2],
        'repo': pathParts[4],
        'prid': pathParts[6]
    };
};

const baseURL = 'https://{server}/rest/api/latest';
const prFetchURLPrefix = `${baseURL}/projects/${getPRMetadata().project}/repos/${getPRMetadata().repo}/pull-requests/${getPRMetadata().prid}`;

// -----------------------------------------------------------------------------------------------
// Change Data
// -----------------------------------------------------------------------------------------------

const fetchChangePaths = async() => {
    let changesFetchUrl = prFetchURLPrefix + '/changes';

    let activity = await fetch(changesFetchUrl);
    let activityResponse = await activity.json();
    let changePaths = Array.from(activityResponse.values, change => {
        return {
            'path': change.path.toString,
            'name': change.path.name,
            'extension': change.path.extension
        };
    });

    return changePaths;
};

const fetchChangeDetail = async(filePath) => {
    let activity = await fetch(prFetchURLPrefix + '/diff/' + filePath);
    let activityResponse = await activity.json();
    return extractSegments(activityResponse.diffs);
};

const extractSegments = (diffs) => {
    let segments = [];

    if (!diffs) {
        return [];
    }

    diffs.forEach(diff => {
        if (!diff.hunks) {
            return;
        }
        diff.hunks.forEach(hunk => {
            segments = segments.concat(hunk.segments);
        })
    })

    return segments;
};

const fetchChanges = async() => {
    let changedFiles = await fetchChangePaths();
    for (let i = 0; i < changedFiles.length; i++) {
        const file = changedFiles[i];
        const x = await fetchChangeDetail(file.path);
        file.segments = x;
    }
    return changedFiles;
};

// -----------------------------------------------------------------------------------------------
//  Analyser Util
// -----------------------------------------------------------------------------------------------

const checkPaths = (changes, pathSubstring, callback) => {
    changes.forEach(change => {
        if (change.path.includes(pathSubstring)) {
            callback();
        }
    });
};

const checkLines = (changes, extension, callback) => {
    changes.forEach(change => {
        if (change.extension !== extension) {
            return;
        }
        change.segments.forEach(segment => {
            if (segment.type !== 'ADDED') {
                return;
            }
            segment.lines.forEach(lineItem => {
                const line = lineItem.line;
                callback(line);
            });
        });
    });
};

// -----------------------------------------------------------------------------------------------
//  Analysers
// -----------------------------------------------------------------------------------------------

/**
 * Analyse total number of changes - if over threshold then maybe need automated tests.
 */
const analyseNumberOfChanges = (changes) => {
    const CHANGE_THRESHOLD = 100;

    const tasks = [];
    let numLinesJS = 0;
    let numLinesJava = 0;

    checkLines(changes, 'js', () => {
        numLinesJS++;
    });
    checkLines(changes, 'java', () => {
        numLinesJava++;
    });

    if (numLinesJS + numLinesJava > CHANGE_THRESHOLD) {
        tasks.push('Significant changes - check if automated tests are required.');
    }

    return tasks;
};

/**
 * Analyse database changes - if changing one type then likely would need to change the other type also.
 */
const analyseDBScriptSynergy = (changes) => {
    const tasks = [];

    let containsMssqlChanges = false;
    let containsOracleChanges = false;

    checkPaths(changes, '/mssql/', () => {
        containsMssqlChanges = true;
    });
    checkPaths(changes, '/oracle/', () => {
        containsOracleChanges = true;
    });

    if (containsMssqlChanges && !containsOracleChanges) {
        tasks.push('MSSQL updated but not Oracle. Check this is ok.');
    }
    if (!containsMssqlChanges && containsOracleChanges) {
        tasks.push('Oracle updated but not MSSQL. Check this is ok.');
    }

    if(containsMssqlChanges || containsOracleChanges) {
        tasks.push('(On merge) Notify the team that there are database changes that need to be applied.');
    }

    return tasks;
};

/**
 * Analyse database changes - if creating new tables then the drop scripts should drop them also.
 */
const analyseDropScriptsNeeded = (changes) => {
    const tasks = [];

    let containsCreateTable = false;
    let containsDropTable = false;

    checkLines(changes, 'sql', (line) => {
        if (line.toLowerCase().includes('create table')) {
            containsCreateTable = true;
        }
    });
    checkLines(changes, 'sql', (line) => {
        if (line.toLowerCase().includes('drop table')) {
            containsDropTable = true;
        }
    });

    if (containsCreateTable && !containsDropTable) {
        tasks.push('Create table but no drop table. Need to update the drop scripts?');
    }

    return tasks;
};


/**
  * Analyse any use of .equals to remind people to use StringUtils.equals instead
 */
const analyseUseOfDotEquals = (changes) => {
    const tasks = [];

    let containsDotEquals = false;

    checkLines(changes, 'java', (line) => {
        if (line.includes('.equals') && !line.includes('StringUtils')) {
            containsDotEquals = true;
        }
    });

    if (containsDotEquals) {
        tasks.push('Found uses of .equals. Review these to check if StringUtils methods are a more appropriate choice.');
    }

    return tasks;
};

const analyse = async () => {
    const parentComment = await addParentComment();
    const parentCommentId = parentComment.comment.id;

    const changes = await fetchChanges();

    let tasks = [];

    tasks = tasks.concat(analyseNumberOfChanges(changes));
    tasks = tasks.concat(analyseDBScriptSynergy(changes));
    tasks = tasks.concat(analyseDropScriptsNeeded(changes));
    tasks = tasks.concat(analyseUseOfDotEquals(changes));

    tasks = tasks.reverse(); // reverse so they show in this order, since they are sorted descending.

    for (let i = 0; i < tasks.length; i++) {
        await addTask(tasks[i], parentCommentId);
    }

    window.location.reload();
};

// -----------------------------------------------------------------------------------------------
//  Comments/Tasks Data
// -----------------------------------------------------------------------------------------------

const PARENT_COMMENT_TEXT = '_Auto-generated comment from PR Analyser_';

const addParentComment = async () => {
    await fetch(prFetchURLPrefix + '/comments', {
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            text: PARENT_COMMENT_TEXT,
        }),
        method: 'POST',
    });
    return await getParentComment();
};

const getParentComment = async () => {
    const activity = await fetch(prFetchURLPrefix + '/activities?limit=500');
    const activityJson = await activity.json();
    return activityJson.values.find(activityItem => {
        if (activityItem?.comment?.text === PARENT_COMMENT_TEXT) {
            return activityItem;
        }
    });
};

const addTask = async (text, commentId) => {
    await fetch(baseURL + '/tasks', {
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            anchor: {
                id: commentId,
                type: 'COMMENT',
            },
            pullRequestId: getPRMetadata().prid,
            text,
            state: 'OPEN',
        }),
        method: 'POST',
    });
};

// -----------------------------------------------------------------------------------------------
//  UI
// -----------------------------------------------------------------------------------------------

const spinner = () => {
    const style = 'width:10px; height:10px; border-radius: 50%; animation: spin 2s linear infinite';
    const borders = 'border-top: 1px solid white; border-bottom: 1px solid white; border-left: 1px solid black; border-right: 1px solid black"';
    return `<div style="${style};${borders}" />`;
};

const getPRTopSection = () => {
    return document.querySelector('.pull-request-details .main-panel');
};

const getContainer = () => {
    return document.querySelector('.pr-analyser');
};

const addContainer = () => {
    const style = 'box-shadow: 3px 3px 3px #bbb; border: 1px solid grey; border-radius: 5px; padding: 10px';
    const prTopSection = getPRTopSection();
    prTopSection.insertAdjacentHTML('afterend', `<div class="aui-item summary-panel"><div class="pr-analyser" style="${style}"></div></div>`);
    const container = getContainer();
    return container;
};

const initialiseAnalyserContainer = async () => {
    const container = addContainer();
    container.innerHTML += '<h6 style="margin-bottom:5px">PR Analyser&trade; ' + VERSION +'</h6>';
    container.innerHTML += '<div class="pr-analyser-content-container" />';

    const contentContainer = container.querySelector('.pr-analyser-content-container');
    contentContainer.innerHTML = spinner();

    let parentComment = await getParentComment();
    if (parentComment) {
        const analyserTasks = parentComment.comment.tasks;
        if (analyserTasks.length === 0) {
            contentContainer.innerHTML = 'All good!';
        } else {
            let listHtml = '<ul style="padding-inline-start:20px">';
            analyserTasks.forEach(task => {
                const resolved = task.state === 'RESOLVED';
                const resolvedStyle = resolved ? 'text-decoration:line-through' : '';
                listHtml += `<li style="margin-bottom:5px;${resolvedStyle}">${task.text}</li>`;
            });
            listHtml += '</ul>';
            contentContainer.innerHTML = listHtml;
            // TODO - re-analyse button?
        }
    } else {
        contentContainer.innerHTML = '<div class="analyse-button-container"><button class="aui-button analyse-button">Analyse</button></div>';
        container.querySelector('.analyse-button').onclick = () => {
            contentContainer.innerHTML = spinner();
            analyse();
        };
    }
};

const addSpinnerCSS = () => {
    var spinCss = document.createElement("style");
    spinCss.innerHTML = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
    document.head.appendChild(spinCss);
};

const setAutoDeleteBranch = () => {
    const { reposlug, projectkey } = document.getElementById('content').dataset;
    const { username } = document.getElementById('current-user').dataset;
    const key = `pr_merge_delete_branch_repo_${reposlug}_${projectkey}_${username}`;
    window.localStorage[key] = `"{"noCleanup":true,"timestamp":${new Date().getTime()},"data":true}"`;
}

const initialiseContainerIfNotAlreadyPresent = async () => {
    const prTopSection = getPRTopSection();
    const container = getContainer();
    if (prTopSection && !container) {
        addSpinnerCSS();
        setAutoDeleteBranch();
        await initialiseAnalyserContainer();
    }
    setTimeout(initialiseContainerIfNotAlreadyPresent, 2000);
};

// -----------------------------------------------------------------------------------------------
//  Merge time suitability analyzer
// -----------------------------------------------------------------------------------------------
const NON_SUITABLE_TIME_RANGE = {
    from: '18:30',
    to: '20:59'
};

const NON_SUITABLE_TIME_RANGE_STRING = NON_SUITABLE_TIME_RANGE.from + '-' + NON_SUITABLE_TIME_RANGE.to;

const isWithinRange = (range, date) => {
    const currentTimeString = date.getHours().toString().padStart(2,'0') + ':' + date.getMinutes().toString().padStart(2,'0');
    return currentTimeString >= range.from && currentTimeString <= range.to;
};

const getMergeButton = () => {
    return document.querySelector('.pull-request-header .merge-button');
};

const getMergeButtonReplacement = () => {
    var replacementForMergeButton = document.createElement("div");
    replacementForMergeButton.setAttribute('class', 'aui-lozenge needs-work pull-request-state-lozenge');
    replacementForMergeButton.setAttribute('title', 'It is not suitable to merge PRs between ' + NON_SUITABLE_TIME_RANGE_STRING + ' because most of the builds kick in during this time period.');
    replacementForMergeButton.innerHTML = 'Not a suitable time for Merge';

    return replacementForMergeButton;
}

const analyzeTimeSuitabilityForMergeAndRemoveAccordingly = async () => {
    if (isWithinRange(NON_SUITABLE_TIME_RANGE, new Date())) { // not suitable time for merge
        const mergeButton = getMergeButton();
        mergeButton.insertAdjacentElement('afterend', getMergeButtonReplacement());
        mergeButton.style.display = 'none';
    }
};

initialiseContainerIfNotAlreadyPresent();
analyzeTimeSuitabilityForMergeAndRemoveAccordingly();
