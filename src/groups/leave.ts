import db from '../database';
import user from '../user';
import plugins from '../plugins';
import cache from '../cache'

type GroupsType = {
    leave: (groupNames: string[], uid: number) => Promise<void>
    isMemberOfGroups: (uid: number, groupNames: string[]) => Promise<boolean[]>
    clearCache: (uid: number, groupsToLeave: string[]) => Promise<void>
    getGroupsFields: (groupsToLeave: string[], str: string) => Promise<GroupsType>   //check str and return type
    isPrivilegeGroups: (name: string) => Promise<boolean>
    destroy: () => Promise<void>     //random stuff here
    leaveAllGroups: (uid: number) => Promise<void>
    rejectMembership: (groups: string[], uid: number) => Promise<void>
    kick: (uid: number, groupName: string, isOwner: boolean) => Promise<void>
}

module.exports = function (Groups: GroupsType) {
    Groups.leave = async function (groupNames, uid) {
        if (Array.isArray(groupNames) && !groupNames.length) {
            return;
        }
        if (!Array.isArray(groupNames)) {
            groupNames = [groupNames];
        }

        const isMembers: boolean[] = await Groups.isMemberOfGroups(uid, groupNames);

        const groupsToLeave: string[] = groupNames.filter((groupName: string, index: number): boolean => isMembers[index]);
        if (!groupsToLeave.length) {
            return;
        }

        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        await Promise.all([
            db.sortedSetRemove(groupsToLeave.map(groupName => `group:${groupName}:members`), uid),
            db.setRemove(groupsToLeave.map(groupName => `group:${groupName}:owners`), uid),
            db.decrObjectField(groupsToLeave.map(groupName => `group:${groupName}`), 'memberCount'),
        ]);

        Groups.clearCache(uid, groupsToLeave);
        cache.del(groupsToLeave.map(name => `group:${name}:members`));

        const groupData = await Groups.getGroupsFields(groupsToLeave, ['name', 'hidden', 'memberCount']);
        if (!groupData) {
            return;
        }

        const emptyPrivilegeGroups = groupData.filter(g => g && Groups.isPrivilegeGroup(g.name) && g.memberCount === 0);
        const visibleGroups = groupData.filter(g => g && !g.hidden);

        const promises = [];
        if (emptyPrivilegeGroups.length) {
            promises.push(Groups.destroy, emptyPrivilegeGroups);
        }
        if (visibleGroups.length) {
            promises.push(
                db.sortedSetAdd,
                'groups:visible:memberCount',
                visibleGroups.map(groupData => groupData.memberCount),
                visibleGroups.map(groupData => groupData.name)
            );
        }

        await Promise.all(promises);

        await clearGroupTitleIfSet(groupsToLeave, uid);

        plugins.hooks.fire('action:group.leave', {
            groupNames: groupsToLeave,
            uid: uid,
        });
    };

    async function clearGroupTitleIfSet(groupNames, uid) {
        groupNames = groupNames.filter(groupName => groupName !== 'registered-users' && !Groups.isPrivilegeGroup(groupName));
        if (!groupNames.length) {
            return;
        }
        const userData = await user.getUserData(uid);
        if (!userData) {
            return;
        }

        const newTitleArray = userData.groupTitleArray.filter(groupTitle => !groupNames.includes(groupTitle));
        if (newTitleArray.length) {
            await db.setObjectField(`user:${uid}`, 'groupTitle', JSON.stringify(newTitleArray));
        } else {
            await db.deleteObjectField(`user:${uid}`, 'groupTitle');
        }
    }

    Groups.leaveAllGroups = async function (uid) {
        const groups = await db.getSortedSetRange('groups:createtime', 0, -1);
        await Promise.all([
            Groups.leave(groups, uid),
            Groups.rejectMembership(groups, uid),
        ]);
    };

    Groups.kick = async function (uid, groupName, isOwner) {
        if (isOwner) {
            // If the owners set only contains one member, error out!
            const numOwners = await db.setCount(`group:${groupName}:owners`);
            if (numOwners <= 1) {
                throw new Error('[[error:group-needs-owner]]');
            }
        }
        await Groups.leave(groupName, uid);
    };
};
